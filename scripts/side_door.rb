#!/usr/bin/env ruby
# frozen_string_literal: true

# UniFi Access Side Door Control Script
# This script allows you to check the status and unlock the side door on UniFi Access Gate Hub devices

require 'net/http'
require 'uri'
require 'json'
require 'openssl'

# Load .env file if it exists
def load_dotenv
  env_file = File.join(File.dirname(__FILE__), '..', '.env')
  env_file = File.expand_path(env_file)
  
  return unless File.exist?(env_file)
  
  File.readlines(env_file).each do |line|
    line = line.strip
    next if line.empty? || line.start_with?('#')
    
    # Parse KEY=VALUE format
    if line =~ /\A([A-Za-z_][A-Za-z0-9_]*)=(.*)?\z/
      key = $1
      value = $2 || ''
      
      # Remove surrounding quotes if present
      value = value.strip
      
      # Handle quoted values (preserve content inside quotes)
      if value.start_with?('"') && value.include?('"')
        # Double-quoted: extract content between first and last double quote
        value = value[1..].split('"').first || ''
      elsif value.start_with?("'") && value.include?("'")
        # Single-quoted: extract content between first and last single quote
        value = value[1..].split("'").first || ''
      else
        # Unquoted: strip inline comments (anything after # with space before it)
        value = value.split(/\s+#/).first || ''
        value = value.strip
      end
      
      # Only set if not already defined in environment
      ENV[key] ||= value
    end
  end
end

# Load .env at startup
load_dotenv

class UniFiAccessClient
  # Port 12445 = Public API (requires API token)
  # Port 443 with /proxy/access = Internal API on UniFi OS (requires API token or session)
  def initialize(host:, api_token:, port: nil, use_proxy: nil)
    @host = host
    @api_token = api_token
    
    # Auto-detect: try port 12445 first, fall back to 443 with proxy
    if port.nil? && use_proxy.nil?
      @port = 12445
      @use_proxy = false
      @fallback_enabled = true
    else
      @port = port || (use_proxy ? 443 : 12445)
      @use_proxy = use_proxy || false
      @fallback_enabled = false
    end
    
    @base_url = "https://#{@host}:#{@port}"
  end

  def api_path(path)
    if @use_proxy
      "/proxy/access#{path}"
    else
      path
    end
  end

  # Fetch all doors with their status
  def fetch_doors
    response = api_request('GET', '/api/v1/developer/doors')
    return nil unless response

    data = JSON.parse(response.body)
    if data['code'] == 'SUCCESS'
      data['data']
    else
      puts "Error: #{data['msg']}"
      nil
    end
  end

  # Fetch a specific door's details
  def fetch_door(door_id)
    response = api_request('GET', "/api/v1/developer/doors/#{door_id}")
    return nil unless response

    data = JSON.parse(response.body)
    if data['code'] == 'SUCCESS'
      data['data']
    else
      puts "Error: #{data['msg']}"
      nil
    end
  end

  # Unlock a door by ID
  def unlock_door(door_id, actor_id: nil, actor_name: nil)
    body = {}
    if actor_id && actor_name
      body[:actor_id] = actor_id
      body[:actor_name] = actor_name
    end

    response = api_request('PUT', "/api/v1/developer/doors/#{door_id}/unlock", body)
    return false unless response

    data = JSON.parse(response.body)
    if data['code'] == 'SUCCESS'
      puts "✅ Door unlocked successfully!"
      true
    else
      puts "❌ Failed to unlock door: #{data['msg']}"
      false
    end
  end

  # Set door lock rule (keep_lock, keep_unlock, custom, reset, lock_early, lock_now)
  def set_lock_rule(door_id, type:, interval: nil)
    body = { type: type }
    body[:interval] = interval if type == 'custom' && interval

    response = api_request('PUT', "/api/v1/developer/doors/#{door_id}/lock_rule", body)
    return false unless response

    data = JSON.parse(response.body)
    if data['code'] == 'SUCCESS'
      puts "✅ Lock rule set successfully!"
      true
    else
      puts "❌ Failed to set lock rule: #{data['msg']}"
      false
    end
  end

  # Get door lock rule
  def get_lock_rule(door_id)
    response = api_request('GET', "/api/v1/developer/doors/#{door_id}/lock_rule")
    return nil unless response

    data = JSON.parse(response.body)
    if data['code'] == 'SUCCESS'
      data['data']
    else
      puts "Error: #{data['msg']}"
      nil
    end
  end

  private

  def api_request(method, path, body = nil)
    uri = URI.parse("#{@base_url}#{api_path(path)}")

    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true
    http.verify_mode = OpenSSL::SSL::VERIFY_NONE # Self-signed cert
    http.read_timeout = 10
    http.open_timeout = 5

    request = case method.upcase
              when 'GET'
                Net::HTTP::Get.new(uri.request_uri)
              when 'POST'
                Net::HTTP::Post.new(uri.request_uri)
              when 'PUT'
                Net::HTTP::Put.new(uri.request_uri)
              when 'DELETE'
                Net::HTTP::Delete.new(uri.request_uri)
              else
                raise "Unknown HTTP method: #{method}"
              end

    request['Authorization'] = "Bearer #{@api_token}"
    request['Content-Type'] = 'application/json'
    request['Accept'] = 'application/json'

    request.body = body.to_json if body && !body.empty?

    response = http.request(request)
    
    # Check if we need to retry with fallback
    if response.code.to_i >= 400 && @fallback_enabled && !@use_proxy
      puts "⚠️  Port 12445 failed, trying port 443 with /proxy/access..."
      @port = 443
      @use_proxy = true
      @base_url = "https://#{@host}:#{@port}"
      @fallback_enabled = false
      return api_request(method, path, body)
    end
    
    response
  rescue Errno::ECONNREFUSED => e
    if @fallback_enabled && !@use_proxy
      puts "⚠️  Port 12445 refused, trying port 443 with /proxy/access..."
      @port = 443
      @use_proxy = true
      @base_url = "https://#{@host}:#{@port}"
      @fallback_enabled = false
      return api_request(method, path, body)
    end
    puts "❌ Connection refused: #{e.message}"
    puts "   Make sure the UniFi Access API is enabled in Settings > General > Advanced"
    nil
  rescue StandardError => e
    puts "❌ Request failed: #{e.message}"
    nil
  end
end

class SideDoorController
  def initialize(client)
    @client = client
  end

  # List all doors with their status
  def list_doors
    doors = @client.fetch_doors
    return unless doors

    puts "\n📋 All Doors:"
    puts '-' * 60

    doors.each_with_index do |door, index|
      lock_status = door['door_lock_relay_status'] == 'lock' ? '🔒 Locked' : '🔓 Unlocked'
      position = case door['door_position_status']
                 when 'open' then '🚪 Open'
                 when 'close' then '🚪 Closed'
                 else '❓ Unknown'
                 end
      hub_status = door['is_bind_hub'] ? '✅ Hub bound' : '❌ No hub'

      puts "#{index + 1}. #{door['full_name']}"
      puts "   ID: #{door['id']}"
      puts "   Status: #{lock_status} | #{position} | #{hub_status}"
      puts
    end

    doors
  end

  # Find side doors (typically contain "side" in the name)
  def find_side_doors
    doors = @client.fetch_doors
    return [] unless doors

    side_doors = doors.select do |door|
      door['name'].to_s.downcase.include?('side') ||
        door['full_name'].to_s.downcase.include?('side')
    end

    if side_doors.empty?
      puts "⚠️  No side doors found. Showing all doors:"
      list_doors
      return doors
    end

    puts "\n🚪 Side Doors Found:"
    puts '-' * 60

    side_doors.each_with_index do |door, index|
      lock_status = door['door_lock_relay_status'] == 'lock' ? '🔒 Locked' : '🔓 Unlocked'
      position = case door['door_position_status']
                 when 'open' then '🚪 Open'
                 when 'close' then '🚪 Closed'
                 else '❓ Unknown'
                 end

      puts "#{index + 1}. #{door['full_name']}"
      puts "   ID: #{door['id']}"
      puts "   Status: #{lock_status} | #{position}"
      puts
    end

    side_doors
  end

  # Check status of a specific door
  def check_door_status(door_id)
    door = @client.fetch_door(door_id)
    return unless door

    puts "\n🚪 Door Status: #{door['full_name']}"
    puts '-' * 40

    lock_status = door['door_lock_relay_status'] == 'lock' ? '🔒 Locked' : '🔓 Unlocked'
    position = case door['door_position_status']
               when 'open' then '🚪 Open'
               when 'close' then '🚪 Closed'
               else '❓ Unknown'
               end

    puts "Lock Status: #{lock_status}"
    puts "Door Position: #{position}"
    puts "Hub Bound: #{door['is_bind_hub'] ? 'Yes' : 'No'}"

    # Get lock rule
    lock_rule = @client.get_lock_rule(door_id)
    if lock_rule
      puts "Lock Rule: #{lock_rule['type']}"
      if lock_rule['ended_time']
        end_time = Time.at(lock_rule['ended_time'])
        puts "Rule Ends: #{end_time}"
      end
    end

    door
  end

  # Unlock a door
  def unlock_door(door_id)
    puts "\n🔓 Unlocking door..."
    @client.unlock_door(door_id)
  end

  # Keep door unlocked
  def keep_unlocked(door_id)
    puts "\n🔓 Setting door to stay unlocked..."
    @client.set_lock_rule(door_id, type: 'keep_unlock')
  end

  # Keep door locked
  def keep_locked(door_id)
    puts "\n🔒 Setting door to stay locked..."
    @client.set_lock_rule(door_id, type: 'keep_lock')
  end

  # Unlock for a specific duration (in minutes)
  def unlock_for_duration(door_id, minutes)
    puts "\n🔓 Unlocking door for #{minutes} minutes..."
    @client.set_lock_rule(door_id, type: 'custom', interval: minutes)
  end

  # Reset door to normal schedule
  def reset_door(door_id)
    puts "\n🔄 Resetting door to normal schedule..."
    @client.set_lock_rule(door_id, type: 'reset')
  end
end

# Interactive CLI
def run_interactive(controller)
  loop do
    puts "\n" + '=' * 50
    puts "UniFi Access Side Door Controller"
    puts '=' * 50
    puts "1. List all doors"
    puts "2. Find side doors"
    puts "3. Check door status (by ID)"
    puts "4. Unlock door (by ID)"
    puts "5. Keep door unlocked (by ID)"
    puts "6. Keep door locked (by ID)"
    puts "7. Unlock for duration (by ID)"
    puts "8. Reset door to schedule (by ID)"
    puts "0. Exit"
    puts '-' * 50
    print "Choose option: "

    choice = gets&.strip

    case choice
    when '1'
      controller.list_doors
    when '2'
      controller.find_side_doors
    when '3'
      print "Enter door ID: "
      door_id = gets&.strip
      controller.check_door_status(door_id) if door_id && !door_id.empty?
    when '4'
      print "Enter door ID: "
      door_id = gets&.strip
      controller.unlock_door(door_id) if door_id && !door_id.empty?
    when '5'
      print "Enter door ID: "
      door_id = gets&.strip
      controller.keep_unlocked(door_id) if door_id && !door_id.empty?
    when '6'
      print "Enter door ID: "
      door_id = gets&.strip
      controller.keep_locked(door_id) if door_id && !door_id.empty?
    when '7'
      print "Enter door ID: "
      door_id = gets&.strip
      print "Enter duration (minutes): "
      minutes = gets&.strip&.to_i
      controller.unlock_for_duration(door_id, minutes) if door_id && !door_id.empty? && minutes.positive?
    when '8'
      print "Enter door ID: "
      door_id = gets&.strip
      controller.reset_door(door_id) if door_id && !door_id.empty?
    when '0', 'q', 'quit', 'exit'
      puts "Goodbye! 👋"
      break
    else
      puts "Invalid option, please try again."
    end
  end
end

# Main execution
if __FILE__ == $PROGRAM_NAME
  # Configuration - Set these environment variables or modify directly
  host = ENV['UNIFI_ACCESS_HOST'] || 'YOUR_ACCESS_CONTROLLER_IP'
  api_token = ENV['UNIFI_ACCESS_TOKEN'] || 'YOUR_API_TOKEN'

  if host == 'YOUR_ACCESS_CONTROLLER_IP' || api_token == 'YOUR_API_TOKEN'
    puts "⚠️  Please configure your UniFi Access controller:"
    puts
    puts "Option 1: Set environment variables:"
    puts "  export UNIFI_ACCESS_HOST='192.168.1.1'"
    puts "  export UNIFI_ACCESS_TOKEN='your-api-token'"
    puts
    puts "Option 2: Edit this script and set the values directly"
    puts
    puts "To get an API token:"
    puts "  1. Go to Access > Settings > General > Advanced"
    puts "  2. Click 'Create New' under API Token"
    puts "  3. Select 'view:space' and 'edit:space' permissions"
    exit 1
  end

  client = UniFiAccessClient.new(host: host, api_token: api_token)
  controller = SideDoorController.new(client)

  # Check for command-line arguments
  case ARGV[0]
  when 'list'
    controller.list_doors
  when 'side'
    controller.find_side_doors
  when 'status'
    if ARGV[1]
      controller.check_door_status(ARGV[1])
    else
      puts "Usage: #{$PROGRAM_NAME} status <door_id>"
    end
  when 'unlock'
    if ARGV[1]
      controller.unlock_door(ARGV[1])
    else
      puts "Usage: #{$PROGRAM_NAME} unlock <door_id>"
    end
  when 'keep-unlocked'
    if ARGV[1]
      controller.keep_unlocked(ARGV[1])
    else
      puts "Usage: #{$PROGRAM_NAME} keep-unlocked <door_id>"
    end
  when 'keep-locked'
    if ARGV[1]
      controller.keep_locked(ARGV[1])
    else
      puts "Usage: #{$PROGRAM_NAME} keep-locked <door_id>"
    end
  when 'help', '-h', '--help'
    puts "UniFi Access Side Door Controller"
    puts
    puts "Usage: #{$PROGRAM_NAME} [command] [args]"
    puts
    puts "Commands:"
    puts "  list                    List all doors"
    puts "  side                    Find side doors"
    puts "  status <door_id>        Check door status"
    puts "  unlock <door_id>        Unlock a door"
    puts "  keep-unlocked <door_id> Keep door unlocked"
    puts "  keep-locked <door_id>   Keep door locked"
    puts "  help                    Show this help"
    puts
    puts "Without arguments, starts interactive mode."
  else
    run_interactive(controller)
  end
end
