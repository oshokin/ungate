import { getSqlite } from '../database';
import { ModelMappings } from '../database/model-mappings';

export interface ReadinessReport {
	ready: boolean;
	status: 'ok' | 'not_ready';
	checks: {
		database: { ok: boolean; detail: string };
		modelMappings: { ok: boolean; detail: string };
	};
}

export function readinessReport(): ReadinessReport {
	const database = check(() => {
		getSqlite().prepare('SELECT 1').get();

		return 'sqlite reachable';
	});
	const modelMappings = check(() => {
		const count = ModelMappings.list().length;
		if (count === 0) throw new Error('no model mappings configured');

		return `${count} model mapping(s) configured`;
	});
	const checks = { database, modelMappings };
	const ready = Object.values(checks).every((item) => item.ok);

	return { ready, status: ready ? 'ok' : 'not_ready', checks };
}

function check(run: () => string): { ok: boolean; detail: string } {
	try {
		return { ok: true, detail: run() };
	} catch {
		return { ok: false, detail: 'unavailable' };
	}
}
