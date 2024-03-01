import {beforeEach, describe, expect, it, vi} from 'vitest';
import {API, Logger} from 'homebridge'; // Mock this if needed
import {AccessPlatform} from "../src/access-platform";
import {AccessContactSensorState} from "../src/interfaces/accessContactSensorState"; // Mock this if needed
import * as AccessContactSensorModule from '../src/access-contactSensor';
import * as LockMechanismModuleModule from '../src/access-lockMechanism';
import * as WebsocketModule from '../src/access-websockets';


describe('AccessPlatform', () => {
    let platform: AccessPlatform;
    let mockLog: Logger;
    let mockApi: API;
    let mockConfig: any; // Define a more specific type if possible
    let eventHandlers = new Map();
    let mockDoorResponse = [{
        door_lock_relay_status: "lock",
        door_position_status: AccessContactSensorState.CLOSE,
        floor_id: "0edb6988-c1fe-4725-9b5b-21c5f0af4a24",
        full_name: "UDM-Pro - Eingang - Haustür",
        id: "testDoorId",
        is_bind_hub: true,
        name: "Haustür",
        type: "door"
    }];

    beforeEach(() => {
        vi.resetAllMocks();
        global.fetch = vi.fn();
        // Mock the logger
        mockLog = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        } as unknown as Logger;

        // Mock the API
        mockApi = {
            on(event: string, handler: (...args: any[]) => void) {
                eventHandlers.set(event, handler);
            },
            trigger(event: string, ...args: any[]) {
                if (eventHandlers.has(event)) {
                    eventHandlers.get(event)(...args);
                }
            },
            hap: {
                Service: {},
                Characteristic: {},
                uuid: {
                    generate: vi.fn().mockImplementation((id) => `uuid-${id}`),
                },
            },
            platformAccessory: class {
                UUID: string;
                context: any;

                constructor(name: string, uuid: string) {
                    this.UUID = uuid;
                    this.context = {name};
                }
            },
            registerPlatformAccessories: vi.fn(),
        } as unknown as API;

        vi.mock('../src/access-websockets', () => ({
            AccessWebsockets: vi.fn().mockImplementation(() => ({}))
        }));

        vi.spyOn(AccessContactSensorModule, 'AccessContactSensor').mockImplementation(
            () => {
                return {
                    update: vi.fn()
                }
            })

        vi.mock('../src/access-lockMechanism', () => ({
            AccessLockMechanism: vi.fn().mockImplementation(() => ({}))
        }));

        // Mock the configuration
        mockConfig = {
            name: 'Test Platform',
            consoleHost: 'localhost',
            apiToken: 'dummyToken',
            doorId: 'testDoorId',
            doorName: 'Test Door',
        };

    });

    it('should initialize the platform correctly', () => {
        platform = new AccessPlatform(mockLog, mockConfig, mockApi);
        expect(mockLog.debug).toHaveBeenCalledWith("Finished initializing platform:", mockConfig.name);
        expect(platform).toBeInstanceOf(AccessPlatform);
        expect(WebsocketModule.AccessWebsockets).toHaveBeenCalled();
    });

    it('should initialize without websocket ', () => {
        platform = new AccessPlatform(mockLog, {...mockConfig, consoleHost: undefined}, mockApi);
        expect(mockLog.error).toHaveBeenCalledWith("Cannot setup WebSocket");
        expect(platform).toBeInstanceOf(AccessPlatform);
        expect(WebsocketModule.AccessWebsockets).not.toHaveBeenCalled();
    });

    it('should configure cached accessories', () => {
        platform = new AccessPlatform(mockLog, mockConfig, mockApi);
        const mockAccessory = {
            displayName: 'Test Accessory',
            UUID: 'uuid-test',
        };
        platform.configureAccessory(mockAccessory as any);
        expect(mockLog.info).toHaveBeenCalledWith("Loading accessory from cache:", mockAccessory.displayName);
        expect(platform.accessories).toContain(mockAccessory);
    });

    it('should handle door setup correctly', () => {
        platform = new AccessPlatform(mockLog, mockConfig, mockApi);
        // Assuming doorId is configured in mockConfig
        expect(platform.setupDoor()).toBeTruthy();

        expect(mockApi.hap.uuid.generate).toHaveBeenCalledWith(mockConfig.doorId);
        expect(mockApi.registerPlatformAccessories).toHaveBeenCalled();
        expect(LockMechanismModuleModule.AccessLockMechanism).toHaveBeenCalled();
    });

    it('should handle door setup correctly', () => {
        platform = new AccessPlatform(mockLog, {...mockConfig, doorId: undefined}, mockApi);
        expect(platform.setupDoor()).toBeFalsy();
        // Verify log messages or other side effects as needed
    });

    it('should setup contact sensor correctly', () => {
        platform = new AccessPlatform(mockLog, mockConfig, mockApi);

        platform.setupContactSensor(mockDoorResponse);

        expect(platform.contactSensor).toBeDefined();
        expect(AccessContactSensorModule.AccessContactSensor).toHaveBeenCalled();
    });

    it('didFinishLaunching triggers device discovery', () => {
        platform = new AccessPlatform(mockLog, mockConfig, mockApi);
        const discoverDevicesSpy = vi.spyOn(platform, 'discoverDevices').mockResolvedValue();

        // Trigger the event
        // @ts-ignore
        mockApi.trigger('didFinishLaunching');

        // Assertions
        expect(discoverDevicesSpy).toHaveBeenCalled();
    });

    it('discoverDevices setups devices', async () => {
        platform = new AccessPlatform(mockLog, mockConfig, mockApi);
        const setupDoorSpy = vi.spyOn(platform, 'setupDoor').mockResolvedValue(true);
        const setupContactSensorSpy = vi.spyOn(platform, 'setupContactSensor').mockResolvedValue();
        const readDoorsSpy = vi.spyOn(platform, 'readDoors').mockResolvedValue({
            code: "success",
            msg: "success",
            data: mockDoorResponse
        });

        await platform.discoverDevices();

        // Assertions
        expect(readDoorsSpy).toHaveBeenCalled();
        expect(setupDoorSpy).toHaveBeenCalled();
        expect(setupContactSensorSpy).toHaveBeenCalledWith(mockDoorResponse);
    });

    it('discoverDevices failed readDoors', async () => {
        platform = new AccessPlatform(mockLog, mockConfig, mockApi);
        const setupDoorSpy = vi.spyOn(platform, 'setupDoor').mockResolvedValue(true);
        const setupContactSensorSpy = vi.spyOn(platform, 'setupContactSensor').mockResolvedValue();
        const readDoorsSpy = vi.spyOn(platform, 'readDoors').mockRejectedValue(new Error("Failed to fetch doors"));

        await platform.discoverDevices();

        // Assertions
        expect(readDoorsSpy).toHaveBeenCalled();
        expect(setupDoorSpy).not.toHaveBeenCalled();
        expect(setupContactSensorSpy).not.toHaveBeenCalledWith(mockDoorResponse);
    });

    it('readDoors from api', async () => {
        const expectedResponse = {data: mockDoorResponse};
        fetch.mockResolvedValueOnce({
            json: vi.fn().mockResolvedValueOnce(expectedResponse),
        });

        platform = new AccessPlatform(mockLog, mockConfig, mockApi);
        const result = await platform.readDoors();
        // Assertions
        expect(result.data).toBe(mockDoorResponse);
    });

    it('readDoors from api failed', async () => {
        const expectedResponse = {data: mockDoorResponse};
        fetch.mockResolvedValueOnce({
            json: vi.fn().mockRejectedValue({"code": "failed"}),
        });

        platform = new AccessPlatform(mockLog, mockConfig, mockApi);
        // Assertions
        await expect(platform.readDoors()).rejects.toThrow('error fetching doors');
    });


});
