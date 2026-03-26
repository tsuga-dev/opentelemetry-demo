// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Grpc.Core;
using StackExchange.Redis;
using Google.Protobuf;
using Microsoft.Extensions.Logging;
using System.Diagnostics.Metrics;
using System.Diagnostics;
using OpenFeature;

namespace cart.cartstore;

public class ValkeyCartStore : ICartStore
{
    private readonly ILogger _logger;
    private const string CartFieldName = "cart";
    private const int RedisRetryNumber = 30;

    private volatile ConnectionMultiplexer _redis;
    private volatile bool _isRedisConnectionOpened;

    private readonly object _locker = new();
    private readonly byte[] _emptyCartBytes;
    private readonly string _connectionString;

    private static readonly ActivitySource CartActivitySource = new("OpenTelemetry.Demo.Cart");
    private static readonly Meter CartMeter = new Meter("OpenTelemetry.Demo.Cart");
    private static readonly Histogram<double> addItemHistogram = CartMeter.CreateHistogram(
        "app.cart.add_item.latency",
        unit: "s",
        advice: new InstrumentAdvice<double>
        {
            HistogramBucketBoundaries = [ 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10 ]
        });
    private static readonly Histogram<double> getCartHistogram = CartMeter.CreateHistogram(
        "app.cart.get_cart.latency",
        unit: "s",
        advice: new InstrumentAdvice<double>
        {
            HistogramBucketBoundaries = [ 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10 ]
        });
    private readonly ConfigurationOptions _redisConnectionOptions;

    private readonly SemaphoreSlim _connectionSlot = new SemaphoreSlim(1, 1);
    private int _poolWaiting = 0;
    private const int PoolSize = 1;
    private readonly IFeatureClient _featureClient;

    private readonly Meter _cartStoreMeter;
    private readonly ObservableGauge<int> _poolSizeGauge;
    private readonly ObservableGauge<int> _poolActiveGauge;
    private readonly ObservableGauge<int> _poolWaitingGauge;

    public ValkeyCartStore(ILogger<ValkeyCartStore> logger, string valkeyAddress, IFeatureClient featureClient)
    {
        _featureClient = featureClient;
        _cartStoreMeter = new Meter("OpenTelemetry.Demo.CartStore");
        _poolSizeGauge = _cartStoreMeter.CreateObservableGauge("db.pool.size", () => PoolSize, "connections", "Simulated connection pool size");
        _poolActiveGauge = _cartStoreMeter.CreateObservableGauge("db.pool.active", () => PoolSize - _connectionSlot.CurrentCount, "connections", "Active connections");
        _poolWaitingGauge = _cartStoreMeter.CreateObservableGauge("db.pool.waiting", () => _poolWaiting, "connections", "Connections waiting for pool slot");

        _logger = logger;
        // Serialize empty cart into byte array.
        var cart = new Oteldemo.Cart();
        _emptyCartBytes = cart.ToByteArray();
        _connectionString = $"{valkeyAddress},ssl=false,allowAdmin=true,abortConnect=false";

        _redisConnectionOptions = ConfigurationOptions.Parse(_connectionString);

        // Try to reconnect multiple times if the first retry fails.
        _redisConnectionOptions.ConnectRetry = RedisRetryNumber;
        _redisConnectionOptions.ReconnectRetryPolicy = new ExponentialRetry(1000);

        _redisConnectionOptions.KeepAlive = 180;
    }

    public ConnectionMultiplexer GetConnection()
    {
        EnsureRedisConnected();
        return _redis;
    }

    public void Initialize()
    {
        EnsureRedisConnected();
    }

    private void EnsureRedisConnected()
    {
        if (_isRedisConnectionOpened)
        {
            return;
        }

        // Connection is closed or failed - open a new one but only at the first thread
        lock (_locker)
        {
            if (_isRedisConnectionOpened)
            {
                return;
            }

            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug("Connecting to Redis: {connectionString}", _connectionString);
            }

            _redis = ConnectionMultiplexer.Connect(_redisConnectionOptions);

            if (_redis == null || !_redis.IsConnected)
            {
                _logger.LogError("Wasn't able to connect to redis");

                // We weren't able to connect to Redis despite some retries with exponential backoff.
                throw new ApplicationException("Wasn't able to connect to redis");
            }

            _logger.LogInformation("Successfully connected to Redis");
            var cache = _redis.GetDatabase();

            _logger.LogDebug("Performing small test");
            cache.StringSet("cart", "OK" );
            object res = cache.StringGet("cart");

            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug("Small test result: {result}", res);
            }

            _redis.InternalError += (_, e) => { Console.WriteLine(e.Exception); };
            _redis.ConnectionRestored += (_, _) =>
            {
                _isRedisConnectionOpened = true;
                _logger.LogInformation("Connection to redis was restored successfully.");
            };
            _redis.ConnectionFailed += (_, _) =>
            {
                _logger.LogInformation("Connection failed. Disposing the object");
                _isRedisConnectionOpened = false;
            };

            _isRedisConnectionOpened = true;
        }
    }

    private async Task<T> ExecuteWithPoolSimulationAsync<T>(Func<IDatabase, Task<T>> operation, Activity activity)
    {
        bool exhaustionEnabled = await _featureClient.GetBooleanValueAsync("valkeyConnectionExhaustion", false);

        if (!exhaustionEnabled)
        {
            var db = GetConnection().GetDatabase();
            return await operation(db);
        }

        int waiting = Interlocked.Increment(ref _poolWaiting);
        activity?.SetTag("db.pool.size", PoolSize);
        activity?.SetTag("db.pool.waiting", waiting);

        bool acquired = await _connectionSlot.WaitAsync(TimeSpan.FromSeconds(5));
        int waitingAtTimeout = Interlocked.Decrement(ref _poolWaiting) + 1;

        if (!acquired)
        {
            _logger.LogWarning(
                "Valkey connection pool exhausted: pool_size={PoolSize} pool_waiting={Waiting} — connection slot not available after 5s timeout",
                PoolSize, waitingAtTimeout);
            activity?.SetTag("db.pool.exhausted", true);
            throw new TimeoutException("Valkey connection pool exhausted");
        }

        try
        {
            activity?.SetTag("db.pool.active", PoolSize - _connectionSlot.CurrentCount);
            await Task.Delay(2000);
            var db = GetConnection().GetDatabase();
            return await operation(db);
        }
        finally
        {
            _connectionSlot.Release();
        }
    }

    public async Task AddItemAsync(string userId, string productId, int quantity)
    {
        var stopwatch = Stopwatch.StartNew();

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("AddItemAsync called with userId={userId}, productId={productId}, quantity={quantity}", userId, productId, quantity);
        }

        try
        {
            EnsureRedisConnected();

            // Access the cart from the cache and write the updated cart in a single pool acquisition
            await ExecuteWithPoolSimulationAsync(
                async db =>
                {
                    var value = await db.HashGetAsync(userId, CartFieldName);

                    Oteldemo.Cart cart;
                    if (value.IsNull)
                    {
                        cart = new Oteldemo.Cart
                        {
                            UserId = userId
                        };
                        cart.Items.Add(new Oteldemo.CartItem { ProductId = productId, Quantity = quantity });
                    }
                    else
                    {
                        cart = Oteldemo.Cart.Parser.ParseFrom(value);
                        var existingItem = cart.Items.SingleOrDefault(i => i.ProductId == productId);
                        if (existingItem == null)
                        {
                            cart.Items.Add(new Oteldemo.CartItem { ProductId = productId, Quantity = quantity });
                        }
                        else
                        {
                            existingItem.Quantity += quantity;
                        }
                    }

                    await db.HashSetAsync(userId, new[]{ new HashEntry(CartFieldName, cart.ToByteArray()) });
                    await db.KeyExpireAsync(userId, TimeSpan.FromMinutes(60));
                    return true;
                },
                Activity.Current);
        }
        catch (Exception ex)
        {
            throw new RpcException(new Status(StatusCode.FailedPrecondition, $"Can't access cart storage. {ex}"));
        }
        finally
        {
            addItemHistogram.Record(stopwatch.Elapsed.TotalSeconds);
        }
    }

    public async Task EmptyCartAsync(string userId)
    {
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("EmptyCartAsync called with userId={userId}", userId);
        }
        try
        {
            EnsureRedisConnected();

            // Update the cache with empty cart for given user
            await ExecuteWithPoolSimulationAsync(
                async db =>
                {
                    await db.HashSetAsync(userId, new[] { new HashEntry(CartFieldName, _emptyCartBytes) });
                    await db.KeyExpireAsync(userId, TimeSpan.FromMinutes(60));
                    return true;
                },
                Activity.Current);
        }
        catch (Exception ex)
        {
            throw new RpcException(new Status(StatusCode.FailedPrecondition, $"Can't access cart storage. {ex}"));
        }
    }

    public async Task<Oteldemo.Cart> GetCartAsync(string userId)
    {
        var stopwatch = Stopwatch.StartNew();

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("GetCartAsync called with userId={userId}", userId);
        }

        try
        {
            EnsureRedisConnected();

            // Access the cart from the cache
            var value = await ExecuteWithPoolSimulationAsync(
                async db => await db.HashGetAsync(userId, CartFieldName),
                Activity.Current);

            if (!value.IsNull)
            {
                return Oteldemo.Cart.Parser.ParseFrom(value);
            }

            // We decided to return empty cart in cases when user wasn't in the cache before
            return new Oteldemo.Cart();
        }
        catch (Exception ex)
        {
            throw new RpcException(new Status(StatusCode.FailedPrecondition, $"Can't access cart storage. {ex}"));
        }
        finally
        {
            getCartHistogram.Record(stopwatch.Elapsed.TotalSeconds);
        }
    }

    public bool Ping()
    {
        try
        {
            var cache = _redis.GetDatabase();
            var res = cache.Ping();
            return res != TimeSpan.Zero;
        }
        catch (Exception)
        {
            return false;
        }
    }
}
