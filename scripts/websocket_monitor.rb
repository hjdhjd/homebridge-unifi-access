#!/usr/bin/env ruby

# WebSocket Monitor for UniFi Access
#
# This script connects to the UniFi Access controller WebSocket and logs all events.
#
# Usage:
#   ruby scripts/websocket_monitor.rb
#
# Environment variables (from .env file):
#   UNIFI_ACCESS_HOST - UniFi controller hostname/IP
#   UNIFI_ACCESS_USER - UniFi username
#   UNIFI_ACCESS_PASS - UniFi password

require 'bundler/inline'

gemfile do
  source 'https://rubygems.org'
  gem 'websocket-client-simple', '~> 0.9'
  gem 'dotenv', '~> 2.8'
end

require 'net/http'
require 'uri'
require 'json'
require 'openssl'
require 'fileutils'
require 'time'

Dotenv.load(File.join(__dir__, '..', '.env'))

# Try different env variable names
HOST = ENV['UNIFI_ACCESS_HOST'] || ENV['UNIFI_HOST']
USERNAME = ENV['UNIFI_ACCESS_USER'] || ENV['UNIFI_USERNAME']
PASSWORD = ENV['UNIFI_ACCESS_PASS'] || ENV['UNIFI_PASSWORD']

unless HOST && USERNAME && PASSWORD
  puts "Missing environment variables."
  puts "Please set in .env file:"
  puts "  UNIFI_ACCESS_HOST=your-controller-ip"
  puts "  UNIFI_ACCESS_USER=your-username"
  puts "  UNIFI_ACCESS_PASS=your-password"
  exit 1
end

LOG_FILE = File.join(__dir__, '..', 'tmp', 'websocket_events.log')

# Ensure tmp directory exists
FileUtils.mkdir_p(File.dirname(LOG_FILE))

# Create/clear log file
File.write(LOG_FILE, "WebSocket Monitor Started: #{Time.now.iso8601}\n#{'=' * 80}\n\n")

def log(message, data = nil)
  timestamp = Time.now.iso8601
  log_message = "[#{timestamp}] #{message}"
  
  if data
    log_message += "\n#{JSON.pretty_generate(data)}"
  end
  
  log_message += "\n#{'-' * 80}\n"
  
  puts log_message
  File.open(LOG_FILE, 'a') { |f| f.write(log_message) }
end

def login
  uri = URI("https://#{HOST}/api/auth/login")
  
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = true
  http.verify_mode = OpenSSL::SSL::VERIFY_NONE
  
  request = Net::HTTP::Post.new(uri.path)
  request['Content-Type'] = 'application/json'
  request.body = JSON.generate({
    username: USERNAME,
    password: PASSWORD,
    remember: true
  })
  
  response = http.request(request)
  
  if response.code == '200'
    cookies = response.get_fields('set-cookie')
    if cookies
      cookie_string = cookies.map { |c| c.split(';').first }.join('; ')
      log('Login successful', { cookies: cookie_string[0..100] + '...' })
      return cookie_string
    else
      raise "No cookies in response"
    end
  else
    raise "Login failed: #{response.code} - #{response.body}"
  end
end

def connect_websocket(cookies)
  # The correct endpoint used by the unifi-access library
  endpoints = [
    "/proxy/access/api/v2/ws/notification",  # This is the correct one!
    "/proxy/access/api/v1/developer/devices/notifications",
    "/api/ws/system"
  ]
  
  endpoints.each do |endpoint|
    begin
      url = "wss://#{HOST}#{endpoint}"
      log("Trying WebSocket endpoint: #{url}")
      
      connected = false
      ws = WebSocket::Client::Simple.connect(url, {
        headers: {
          'Cookie' => cookies
        },
        verify_mode: OpenSSL::SSL::VERIFY_NONE
      })
      
      ws.on :open do
        connected = true
        log("Connected to WebSocket: #{endpoint}")
        log("Monitoring WebSocket events. Logs are written to: #{LOG_FILE}")
        log("Press Ctrl+C to stop.")
      end
      
      ws.on :message do |msg|
        begin
          data = JSON.parse(msg.data)
          log('WebSocket Message', data)
        rescue JSON::ParserError
          log('WebSocket Raw Message', { raw: msg.data.to_s })
        end
      end
      
      ws.on :close do |e|
        log("WebSocket closed: #{e}")
      end
      
      ws.on :error do |e|
        log("WebSocket error: #{e.message}")
      end
      
      # Wait for connection
      sleep 2
      
      if connected
        # Keep the connection alive
        loop do
          sleep 1
          break unless ws.open?
        end
        return
      end
      
    rescue => e
      log("Failed to connect to #{endpoint}: #{e.message}")
    end
  end
  
  raise "Could not connect to any WebSocket endpoint"
end

# Handle graceful shutdown
trap('INT') do
  log('Shutting down...')
  exit 0
end

begin
  log('Starting WebSocket Monitor')
  log("Host: #{HOST}")
  log("Log file: #{LOG_FILE}")
  
  cookies = login
  connect_websocket(cookies)
  
rescue => e
  log("Error: #{e.message}")
  log("Backtrace: #{e.backtrace.join("\n")}")
  exit 1
end
