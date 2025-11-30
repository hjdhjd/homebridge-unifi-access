#!/usr/bin/env ruby
# frozen_string_literal: true

# UniFi Access Device Configuration Checker
# This script fetches and displays the full device configuration to debug side door issues

require 'net/http'
require 'uri'
require 'json'
require 'openssl'

class DeviceConfigChecker
  def initialize
    load_env
    @base_url = "https://#{@host}:#{@port}"
  end

  def load_env
    # Try .env in scripts directory first, then project root
    env_file = File.join(File.dirname(__FILE__), '.env')
    unless File.exist?(env_file)
      env_file = File.join(File.dirname(__FILE__), '..', '.env')
    end
    
    puts "Looking for .env at: #{env_file}"
    puts "File exists: #{File.exist?(env_file)}"
    
    if File.exist?(env_file)
      File.readlines(env_file).each do |line|
        line = line.strip
        next if line.empty? || line.start_with?('#')
        
        if line.include?('=')
          key, value = line.split('=', 2)
          key = key.strip
          # Remove inline comments and quotes
          value = value.split('#').first.strip.gsub(/^["']|["']$/, '')
          ENV[key] = value
        end
      end
    end

    @host = ENV['UNIFI_HOST'] || ENV['UNIFI_ACCESS_HOST'] || '192.168.2.1'
    @port = ENV['UNIFI_PORT'] || '12445'
    @token = ENV['UNIFI_API_TOKEN'] || ENV['UNIFI_ACCESS_TOKEN']

    unless @token
      puts "❌ Error: UNIFI_API_TOKEN not set"
      puts "Create a .env file in the scripts directory with:"
      puts "  UNIFI_HOST=your_controller_ip"
      puts "  UNIFI_PORT=12445"
      puts "  UNIFI_API_TOKEN=your_api_token"
      exit 1
    end
  end

  def api_request(endpoint)
    uri = URI.parse("#{@base_url}#{endpoint}")
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    http.verify_mode = OpenSSL::SSL::VERIFY_NONE
    http.open_timeout = 10
    http.read_timeout = 30

    request = Net::HTTP::Get.new(uri.request_uri)
    request['Authorization'] = "Bearer #{@token}"
    request['Content-Type'] = 'application/json'
    request['Accept'] = 'application/json'

    response = http.request(request)
    
    if response.code.to_i == 200
      JSON.parse(response.body)
    else
      puts "❌ API Error: #{response.code} - #{response.message}"
      nil
    end
  rescue => e
    puts "❌ Connection Error: #{e.message}"
    nil
  end

  def check_devices
    puts "=" * 70
    puts "UniFi Access Device Configuration Checker"
    puts "=" * 70
    puts "\nConnecting to #{@base_url}..."

    # Get devices
    data = api_request('/api/v1/developer/devices')
    
    unless data && data['data']
      puts "❌ Failed to fetch devices"
      return
    end

    devices = data['data']
    devices = [devices] if devices.is_a?(Hash)  # Handle single device response
    puts "✅ Found #{devices.length} device(s)\n\n"

    devices.each_with_index do |device, idx|
      next unless device.is_a?(Hash)  # Skip if not a hash
      puts "-" * 70
      puts "Device #{idx + 1}: #{device['name'] || device['alias'] || 'Unknown'}"
      puts "-" * 70
      
      puts "  ID:           #{device['id']}"
      puts "  Type:         #{device['device_type']}"
      puts "  Model:        #{device['model']}"
      puts "  Display Model:#{device['display_model']}"
      puts "  MAC:          #{device['mac']}"
      puts "  Firmware:     #{device['firmware']}"
      puts "  Online:       #{device['is_online']}"
      
      # Check for extensions (important for side door)
      if device['extensions'] && !device['extensions'].empty?
        puts "\n  📦 Extensions:"
        device['extensions'].each do |ext|
          puts "    - extension_name: #{ext['extension_name']}"
          puts "      target_name:    #{ext['target_name']}"
          puts "      target_value:   #{ext['target_value']}"
          puts ""
        end
      else
        puts "\n  ⚠️  No extensions found (side door requires 'port_setting' extension)"
      end

      # Check for configs
      if device['configs'] && !device['configs'].empty?
        puts "\n  ⚙️  Configs:"
        device['configs'].each do |config|
          puts "    - #{config['key']}: #{config['value']}"
        end
      end

      # Check capabilities
      if device['capabilities'] && !device['capabilities'].empty?
        puts "\n  🔧 Capabilities: #{device['capabilities'].join(', ')}"
      end

      puts ""
    end

    # Also check doors/locations
    puts "\n" + "=" * 70
    puts "Checking Doors/Locations..."
    puts "=" * 70

    doors_data = api_request('/api/v1/developer/doors')
    
    if doors_data && doors_data['data']
      doors = doors_data['data']
      puts "✅ Found #{doors.length} door(s)\n\n"

      doors.each_with_index do |door, idx|
        puts "-" * 70
        puts "Door #{idx + 1}: #{door['name'] || 'Unknown'}"
        puts "-" * 70
        puts "  ID:           #{door['id']}"
        puts "  Full Name:    #{door['full_name']}"
        puts "  Type:         #{door['location_type']}"
        puts "  Lock Status:  #{door['door_lock_relay_status']}"
        puts "  Door Status:  #{door['door_position_status']}"
        
        if door['hub']
          puts "\n  🔌 Hub Info:"
          puts "    Hub ID:     #{door['hub']['id']}"
          puts "    Hub Name:   #{door['hub']['name']}"
          puts "    Device Type:#{door['hub']['device_type']}"
        end

        # Check for extra fields that might indicate side door relationship
        door.each do |key, value|
          next if ['id', 'name', 'full_name', 'location_type', 'door_lock_relay_status', 
                   'door_position_status', 'hub', 'timezone', 'work_time', 'extras',
                   'work_time_id', 'floor_id', 'level', 'up', 'camera_resource_ids'].include?(key)
          puts "  #{key}: #{value}" if value && value.to_s.length < 100
        end
        
        puts ""
      end
    end

    # Check the hub endpoint specifically
    puts "\n" + "=" * 70
    puts "Checking Hub Details..."
    puts "=" * 70

    puts "\nRaw devices data type: #{devices.class}"
    puts "Raw devices data:"
    puts JSON.pretty_generate(data['data'])
    
    # Find UGT devices - handle both array and other structures
    if devices.is_a?(Array)
      ugt_devices = devices.select { |d| d.is_a?(Hash) && d['device_type'] == 'UGT' }
    else
      ugt_devices = []
    end
    
    if ugt_devices.empty?
      puts "⚠️  No UA Gate Hub (UGT) devices found"
      puts "   Side door feature is only available on UA Gate Hub devices"
    else
      ugt_devices.each do |device|
        puts "\nUA Gate Hub: #{device['name']}"
        puts "Full device data:"
        puts JSON.pretty_generate(device)
      end
    end
  end
end

# Run the checker
checker = DeviceConfigChecker.new
checker.check_devices
