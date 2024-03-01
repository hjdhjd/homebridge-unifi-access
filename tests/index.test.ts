import { describe, it, expect, vi } from 'vitest';
import registerPlatform from '../src/index';

vi.mock('./access-platform', () => ({
    AccessPlatform: class MockAccessPlatform {}
}));

describe('Platform Registration', () => {
    it('should register the platform with Homebridge', () => {
        const mockApi = {
            registerPlatform: vi.fn()
        };

        // Call the function that registers the platform
        registerPlatform(mockApi as any);

        // Check that registerPlatform was called with the correct platform name and class
        expect(mockApi.registerPlatform).toHaveBeenCalledWith('UniFi Access', expect.anything());
    });
});
