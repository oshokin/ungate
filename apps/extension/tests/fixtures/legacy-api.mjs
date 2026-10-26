// Controlled reproduction of the old health contract and missing /usage route.
import { createServer } from 'node:http';

const server = createServer((request, response) => {
	response.setHeader('Content-Type', 'application/json');
	if (request.url === '/health') return response.end(JSON.stringify({ status: 'ok', service: 'ungate', pid: process.pid }));
	if (
		request.url === '/admin/shutdown' &&
		request.method === 'POST' &&
		request.headers.authorization === `Bearer ${process.env.UNGATE_ADMIN_TOKEN}`
	) {
		response.end(JSON.stringify({ ok: true }));
		setTimeout(() => process.exit(0), 50);

		return;
	}
	response.writeHead(request.url === '/admin/shutdown' ? 403 : 404);
	response.end(JSON.stringify({ error: 'Not Found' }));
});
server.listen(Number(process.env.PORT), '127.0.0.1', () => process.stdout.write('ready\n'));
