import { API_PROTOCOL_VERSION, UNGATE_VERSION, type RuntimeState } from '@ungate/shared/frontend';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedServiceController } from '../../src/shared-service-controller';

import { TestHelper } from './helpers/test-helper';

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	mutate: vi.fn(),
	touch: vi.fn(),
	health: vi.fn(),
	protocol: vi.fn(),
	lock: vi.fn()
}));
vi.mock('../../src/runtime-state', () => ({
	RuntimeStateStore: { read: mocks.read, mutate: mocks.mutate, touchClient: mocks.touch }
}));
vi.mock('../../src/local-api', () => ({ readApiHealth: mocks.health, readTunnelProtocol: mocks.protocol }));
vi.mock('../../src/utils/cross-process-lock', () => ({ CrossProcessLock: { acquire: mocks.lock } }));
let state: RuntimeState;

beforeEach(() => {
	vi.clearAllMocks();
	state = TestHelper.createRuntimeState(['old-window', 'new-window'], 47821);
	state.api.ownerWindowId = 'old-window';
	Object.assign(state.tunnel, { status: 'running', url: 'https://shared.trycloudflare.com', port: 47821 });
	mocks.read.mockImplementation(() => state);
	mocks.mutate.mockImplementation((fn: (current: RuntimeState) => RuntimeState) => {
		state = fn(state);

		return Promise.resolve(state);
	});
	mocks.touch.mockResolvedValue(undefined);
	mocks.lock.mockResolvedValue(vi.fn());
	mocks.health.mockResolvedValue({ service: 'ungate', pid: 123, version: UNGATE_VERSION, protocolVersion: API_PROTOCOL_VERSION });
	mocks.protocol.mockResolvedValue('http2');
});

function create(active = true) {
	const api = {
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		restart: vi.fn().mockResolvedValue(undefined),
		getPort: () => state.api.port
	};
	const tunnel = {
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		restart: vi.fn().mockResolvedValue(undefined)
	};

	return { api, tunnel, controller: new SharedServiceController(api as never, tunnel as never, 'new-window', () => active) };
}

describe('shared service actions', () => {
	it('upgrades in the requesting window and preserves a same-port tunnel', async () => {
		mocks.health.mockResolvedValue({ service: 'ungate', pid: 123, version: null, protocolVersion: null });
		const { api, tunnel, controller } = create();
		api.restart.mockImplementation(() => {
			expect(state.api.ownerWindowId).toBe('new-window');

			return Promise.resolve();
		});
		await controller.run('restart-services');
		expect(mocks.lock).toHaveBeenCalledWith('commands.lock', 180000);
		expect(api.restart).toHaveBeenCalledOnce();
		expect(tunnel.restart).not.toHaveBeenCalled();
		expect(state.tunnel.url).toBe('https://shared.trycloudflare.com');
	});
	it('never restarts a newer API from an older window', async () => {
		mocks.health.mockResolvedValue({ service: 'ungate', pid: 123, version: '1.8.0', protocolVersion: 1 });
		const { api, controller } = create();
		await expect(controller.run('restart-services')).rejects.toThrow('will not be downgraded');
		expect(api.restart).not.toHaveBeenCalled();
		expect(state.api.ownerWindowId).toBe('old-window');
	});
	it('suppresses auto-start before stopping services in all windows', async () => {
		const { api, tunnel, controller } = create();
		tunnel.stop.mockImplementation(() => {
			expect(state.api.startSuppressed).toBe(true);

			return Promise.resolve();
		});
		await controller.run('stop-services');
		expect(tunnel.stop).toHaveBeenCalledOnce();
		expect(api.stop).toHaveBeenCalledOnce();
	});
	it('starts API as well when Start tunnel follows Stop all', async () => {
		state.api.startSuppressed = true;
		const { api, tunnel, controller } = create();
		await controller.run('start-tunnel');
		expect(api.restart).toHaveBeenCalledOnce();
		expect(tunnel.start).toHaveBeenCalledWith(47821, 'http2');
	});
	it('refuses tunnel start against a legacy API', async () => {
		mocks.health.mockResolvedValue({ service: 'ungate', pid: 123, version: null, protocolVersion: null });
		const { tunnel, controller } = create();
		await expect(controller.run('start-tunnel')).rejects.toThrow('Update the API');
		expect(tunnel.start).not.toHaveBeenCalled();
	});
	it('reconnects the tunnel when the API port changes', async () => {
		const { api, tunnel, controller } = create();
		api.restart.mockImplementation(() => {
			state.api.port = 47822;

			return Promise.resolve();
		});
		await controller.run('restart-services');
		expect(tunnel.restart).toHaveBeenCalledWith(47822, 'http2');
	});
	it('restarts a running tunnel when the saved protocol changes', async () => {
		mocks.protocol.mockResolvedValue('quic');
		const { tunnel, controller } = create();
		await controller.run('restart-services');
		expect(tunnel.restart).toHaveBeenCalledWith(47821, 'quic');
	});
	it('propagates failure and releases the cross-window lock', async () => {
		const release = vi.fn();
		mocks.lock.mockResolvedValue(release);
		const { api, controller } = create();
		api.restart.mockRejectedValue(new Error('Shutdown forbidden'));
		await expect(controller.run('restart-services')).rejects.toThrow('Shutdown forbidden');
		expect(release).toHaveBeenCalledOnce();
	});
	it('does not run commands after the requesting window closes', async () => {
		const { api, controller } = create(false);
		await expect(controller.run('restart-services')).rejects.toThrow('has closed');
		expect(api.restart).not.toHaveBeenCalled();
	});
});
