import { MiniMaxStreamHandler } from 'src/streaming/minimax-stream-handler';
import { OpenAIStreamHandler } from 'src/streaming/openai-stream-handler';
import { reliableOpenAiStream } from 'src/streaming/stream-reliability';

import type { FastifyReply } from 'fastify';
import type { RequestContext } from 'src/types/proxy';

export class CompletionStreamingGateway {
	static copyUpstreamHeaders(reply: FastifyReply, response: Response, transformed = false): void {
		const framingHeaders = new Set([
			'content-encoding',
			'content-length',
			'transfer-encoding',
			'connection',
			'keep-alive',
			'trailer',
			'te',
			'upgrade'
		]);
		for (const [key, value] of response.headers.entries()) {
			if (key.toLowerCase() === 'content-encoding' || (transformed && framingHeaders.has(key.toLowerCase()))) {
				continue;
			}

			reply.header(key, value);
		}
	}

	static sendMiniMaxStream(reply: FastifyReply, response: Response, minimaxModel: string, context: RequestContext): FastifyReply {
		CompletionStreamingGateway.copyUpstreamHeaders(reply, response, true);
		reply.code(response.status);

		const { stream, headers: streamHeaders } = MiniMaxStreamHandler.createStreamResponse(
			response,
			Date.now().toString(),
			minimaxModel,
			context
		);

		for (const [key, value] of Object.entries(streamHeaders)) {
			reply.header(key, value);
		}

		return reply.send(reliableOpenAiStream(stream));
	}

	static sendOpenAiPassthroughStream(reply: FastifyReply, response: Response): FastifyReply {
		CompletionStreamingGateway.copyUpstreamHeaders(reply, response);
		reply.code(response.status);

		return reply.send(response.body ? reliableOpenAiStream(response.body) : response.body);
	}

	static sendClaudeAsOpenAiStream(
		reply: FastifyReply,
		response: Response,
		streamId: string,
		openaiModel: string,
		context: RequestContext
	): FastifyReply {
		const { stream, headers: streamHeaders } = OpenAIStreamHandler.createStreamResponse(response, streamId, openaiModel, context);
		CompletionStreamingGateway.copyUpstreamHeaders(reply, response, true);

		for (const [key, value] of Object.entries(streamHeaders)) {
			reply.header(key, value);
		}

		return reply.send(reliableOpenAiStream(stream));
	}
}
