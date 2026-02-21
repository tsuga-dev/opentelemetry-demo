# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

require "ostruct"
require "pony"
require "sinatra"
require "open_feature/sdk"
require "openfeature/flagd/provider"

require "opentelemetry/sdk"
require "opentelemetry-logs-sdk"
require "opentelemetry-metrics-sdk"
require "opentelemetry/exporter/otlp"
require "opentelemetry-exporter-otlp-logs"
require "opentelemetry-exporter-otlp-metrics"
require "opentelemetry/instrumentation/sinatra"

set :port, ENV["EMAIL_PORT"]

# Initialize OpenFeature SDK with flagd provider
flagd_client = OpenFeature::Flagd::Provider.build_client
flagd_client.configure do |config|
  config.host = ENV.fetch("FLAGD_HOST", "localhost")
  config.port = ENV.fetch("FLAGD_PORT", 8013).to_i
  config.tls = ENV.fetch("FLAGD_TLS", "false") == "true"
end

OpenFeature::SDK.configure do |config|
  config.set_provider(flagd_client)
end

OpenTelemetry::SDK.configure do |c|
  c.use "OpenTelemetry::Instrumentation::Sinatra"
end

$logger = OpenTelemetry.logger_provider.logger(name: 'email')

# Configure OTLP metrics exporter
otlp_metric_exporter = OpenTelemetry::Exporter::OTLP::Metrics::MetricsExporter.new
OpenTelemetry.meter_provider.add_metric_reader(otlp_metric_exporter)
meter = OpenTelemetry.meter_provider.meter("email")

# Metrics
$confirmation_counter = meter.create_counter("app.confirmation.counter", unit: "1", description: "Counts the number of order confirmation emails sent")
$email_sent_counter = meter.create_counter("email.sent.total", unit: "{emails}", description: "Total emails sent by status")
$email_errors_counter = meter.create_counter("email.errors.total", unit: "{errors}", description: "Email sending errors by type")
$email_duration = meter.create_histogram("email.send.duration", unit: "ms", description: "Email sending duration")
$email_size_bytes = meter.create_histogram("email.size.bytes", unit: "By", description: "Email body size in bytes")
$email_queue_depth = meter.create_up_down_counter("email.queue.depth", unit: "{emails}", description: "Number of emails in queue")
$memory_leak_flag_checks = meter.create_counter("email.feature_flag.evaluations.total", unit: "{evaluations}", description: "Feature flag evaluation count")
$email_body_length = meter.create_histogram("email.body.length", unit: "{characters}", description: "Email body length in characters")

post "/send_order_confirmation" do
  start_time = Time.now
  data = JSON.parse(request.body.read, object_class: OpenStruct)

  # get the current auto-instrumented span
  current_span = OpenTelemetry::Trace.current_span
  current_span.add_attributes({
    "app.order.id" => data.order.order_id,
    "app.email.recipient" => data.email,
  })

  # Log request received with trace correlation
  log_with_trace('INFO', 'Order confirmation request received', {
    'event' => 'email_confirmation_requested',
    'order.id' => data.order.order_id,
    'email.recipient' => data.email,
  })

  begin
    $confirmation_counter.add(1)
    $email_queue_depth.add(1)
    
    send_email(data)
    
    duration_ms = ((Time.now - start_time) * 1000).round(2)
    $email_sent_counter.add(1, attributes: { 'status' => 'success' })
    $email_duration.record(duration_ms, attributes: { 'status' => 'success' })
    $email_queue_depth.add(-1)

    log_with_trace('INFO', 'Order confirmation email sent successfully', {
      'event' => 'email_sent',
      'order.id' => data.order.order_id,
      'email.recipient' => data.email,
      'duration_ms' => duration_ms,
    })

    status 200
    body "Email sent successfully"
  rescue => e
    duration_ms = ((Time.now - start_time) * 1000).round(2)
    $email_sent_counter.add(1, attributes: { 'status' => 'error' })
    $email_errors_counter.add(1, attributes: { 'error_type' => e.class.name })
    $email_duration.record(duration_ms, attributes: { 'status' => 'error' })
    $email_queue_depth.add(-1)

    log_with_trace('ERROR', 'Failed to send order confirmation email', {
      'event' => 'email_send_failed',
      'order.id' => data.order.order_id,
      'email.recipient' => data.email,
      'error' => e.message,
      'error_type' => e.class.name,
      'duration_ms' => duration_ms,
    })

    current_span.record_exception(e)
    status 500
    body "Failed to send email: #{e.message}"
  end
end

error do
  OpenTelemetry::Trace.current_span.record_exception(env['sinatra.error'])
end

# Helper function for trace-correlated logging
def log_with_trace(severity, message, attributes = {})
  # Get current span context for trace correlation
  span = OpenTelemetry::Trace.current_span
  span_context = span.context if span
  
  # Add trace context to attributes
  if span_context
    attributes['trace_id'] = span_context.trace_id.unpack1('H*')
    attributes['span_id'] = span_context.span_id.unpack1('H*')
    attributes['trace_flags'] = span_context.trace_flags.to_s
  end

  # Emit structured log with OTLP
  $logger.on_emit(
    timestamp: Time.now,
    severity_text: severity,
    body: message,
    attributes: attributes,
  )
end

def send_email(data)
  # create and start a manual span
  tracer = OpenTelemetry.tracer_provider.tracer('email')
  tracer.in_span("send_email") do |span|
    # Check if memory leak flag is enabled
    client = OpenFeature::SDK.build_client
    memory_leak_multiplier = client.fetch_number_value(flag_key: "emailMemoryLeak", default_value: 0)
    
    $memory_leak_flag_checks.add(1, attributes: {
      'flag_key' => 'emailMemoryLeak',
      'flag_value' => memory_leak_multiplier.to_s,
    })

    log_with_trace('INFO', 'Feature flag evaluated', {
      'event' => 'feature_flag_evaluated',
      'flag_key' => 'emailMemoryLeak',
      'flag_value' => memory_leak_multiplier,
      'order.id' => data.order.order_id,
    })

    # To speed up the memory leak we create a long email body
    confirmation_content = erb(:confirmation, locals: { order: data.order })
    whitespace_length = [0, confirmation_content.length * (memory_leak_multiplier-1)].max
    email_body = confirmation_content + " " * whitespace_length

    # Track email size metrics
    body_size_bytes = email_body.bytesize
    body_length_chars = email_body.length
    $email_size_bytes.record(body_size_bytes)
    $email_body_length.record(body_length_chars, attributes: {
      'memory_leak_enabled' => (memory_leak_multiplier >= 1).to_s,
    })

    log_with_trace('INFO', 'Email template rendered', {
      'event' => 'email_template_rendered',
      'order.id' => data.order.order_id,
      'body_size_bytes' => body_size_bytes,
      'body_length_chars' => body_length_chars,
      'memory_leak_multiplier' => memory_leak_multiplier,
    })

    Pony.mail(
      to:       data.email,
      from:     "noreply@example.com",
      subject:  "Your confirmation email",
      body:     email_body,
      via:      :test
    )

    # If not clearing the deliveries, the emails will accumulate in the test mailer
    # We use this to create a memory leak.
    if memory_leak_multiplier < 1
      Mail::TestMailer.deliveries.clear
      log_with_trace('DEBUG', 'Email deliveries cleared', {
        'event' => 'deliveries_cleared',
        'order.id' => data.order.order_id,
      })
    else
      log_with_trace('WARN', 'Memory leak mode active - deliveries not cleared', {
        'event' => 'memory_leak_active',
        'order.id' => data.order.order_id,
        'memory_leak_multiplier' => memory_leak_multiplier,
        'deliveries_count' => Mail::TestMailer.deliveries.count,
      })
    end

    span.set_attribute("app.email.recipient", data.email)
    span.set_attribute("app.email.size_bytes", body_size_bytes)
    span.set_attribute("app.memory_leak_multiplier", memory_leak_multiplier)

    puts "Order confirmation email sent to: #{data.email}"
  end
  # manually created spans need to be ended
  # in Ruby, the method `in_span` ends it automatically
  # check out the OpenTelemetry Ruby docs at: 
  # https://opentelemetry.io/docs/instrumentation/ruby/manual/#creating-new-spans 
end
