// Worker entry point. The logic lives in proxy.ts (see its header for the
// security model). Keep this module to the default export only: workerd treats
// every named export of the main module as an entrypoint and fails to start on
// anything else (e.g. an exported constant).
import { errorResponse, handleRequest } from './proxy';

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch {
      console.error('ai-proxy: unexpected error');
      return errorResponse(500, 'internal_error', 'Something went wrong.', {});
    }
  },
} satisfies ExportedHandler<Env>;
