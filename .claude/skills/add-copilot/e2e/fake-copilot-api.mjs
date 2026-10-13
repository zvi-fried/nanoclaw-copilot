// A local stand-in for GitHub's Copilot API (api.github.com/copilot_internal
// and *.githubcopilot.com), served over TLS. It answers only requests that
// carry the real token; a request with the runtime's placeholder or anything
// else gets 401, as GitHub would. Every request is logged with which
// credential it carried, never the value. The model is scripted by keyword.
//
// Env: E2E_REAL_TOKEN, E2E_CERT, E2E_KEY, E2E_LOG, E2E_PORT, E2E_DESTINATION.
import fs from 'node:fs';
import https from 'node:https';

const REAL = process.env.E2E_REAL_TOKEN;
const LOG = process.env.E2E_LOG;
const DESTINATION = process.env.E2E_DESTINATION;
if (!REAL || !LOG) throw new Error('E2E_REAL_TOKEN and E2E_LOG are required');

const text = (m) =>
  typeof m?.content === 'string'
    ? m.content
    : Array.isArray(m?.content)
      ? m.content.map((p) => p.text ?? '').join('')
      : '';
// Replies go to the session's destination, as an agent would address them.
const addressed = (body) => (DESTINATION ? `<message to="${DESTINATION}">${body}</message>` : body);

function decide(req) {
  const messages = req.messages ?? [];
  const last = messages.at(-1);
  const prompt = text([...messages].reverse().find((m) => m.role === 'user'));
  const all = JSON.stringify(req);
  const tools = (req.tools ?? []).map((t) => t.function?.name).filter(Boolean);
  if (last?.role === 'tool') return { content: addressed(`TOOL RESULT: ${text(last).split('\n')[0]}`) };
  if (/<skill-context name="nanoclaw-test-skill">[\s\S]*SKILL-BODY-MARKER/.test(prompt))
    return { content: addressed('SKILL-BODY-MARKER') };
  if (/USE_MCP/.test(prompt)) {
    const tool = tools.find((n) => /echo$/.test(n));
    return tool ? { tool, args: { text: 'ping-from-model' } } : { content: addressed(`no MCP tool among ${tools}`) };
  }
  if (/USE_SHELL/.test(prompt)) {
    return tools.includes('bash')
      ? { tool: 'bash', args: { command: 'echo shell-ok', description: 'echo' } }
      : { content: addressed('no shell tool') };
  }
  if (/USE_SKILL/.test(prompt)) {
    return tools.includes('skill') && /nanoclaw-test-skill/.test(all)
      ? { tool: 'skill', args: { skill: 'nanoclaw-test-skill' } }
      : { content: addressed('skill not available') };
  }
  if (/CHECK_MEMORY/.test(prompt))
    return {
      content: addressed(
        `MEMORY: ${/MEMORY-MARKER-42/.test(all) ? 'yes' : 'no'}; PROJECT DOC: ${/PROJECT-DOC-MARKER/.test(all) ? 'yes' : 'no'}`,
      ),
    };
  return { content: addressed('hello from fake copilot') };
}

const MODEL = {
  id: 'gpt-4.1',
  name: 'GPT-4.1',
  object: 'model',
  vendor: 'Azure OpenAI',
  version: 'gpt-4.1-2025-04-14',
  preview: false,
  model_picker_enabled: true,
  model_picker_category: 'versatile',
  is_chat_default: true,
  is_chat_fallback: true,
  supported_endpoints: ['/chat/completions'],
  capabilities: {
    type: 'chat',
    family: 'gpt-4.1',
    tokenizer: 'o200k_base',
    object: 'model_capabilities',
    limits: { max_context_window_tokens: 128000, max_output_tokens: 16384, max_prompt_tokens: 128000 },
    supports: { streaming: true, tool_calls: true, parallel_tool_calls: true, structured_outputs: true, vision: false },
  },
  policy: { state: 'enabled', terms: 'Enable access to GPT-4.1.' },
  billing: { is_premium: false, multiplier: 0 },
};

const server = https.createServer(
  { key: fs.readFileSync(process.env.E2E_KEY), cert: fs.readFileSync(process.env.E2E_CERT) },
  async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const host = (req.headers.host ?? '').split(':')[0];
    const auth = req.headers.authorization ?? '';
    const credential = auth.includes(REAL)
      ? 'real'
      : auth.includes('nc-copilot-token-v1')
        ? 'placeholder'
        : auth
          ? 'other'
          : 'none';
    const path = (req.url ?? '/').split('?')[0];
    fs.appendFileSync(
      LOG,
      JSON.stringify({
        host,
        method: req.method,
        path,
        credential,
        tools: (() => {
          try {
            return (JSON.parse(body).tools ?? []).map((t) => t.function?.name);
          } catch {
            return undefined;
          }
        })(),
      }) + '\n',
    );
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (credential !== 'real') return json(401, { message: 'Bad credentials' });
    if (host === 'api.github.com') {
      if (path === '/copilot_internal/user')
        return json(200, {
          login: 'e2e-user',
          chat_enabled: true,
          is_mcp_enabled: true,
          copilot_plan: 'individual',
          endpoints: { api: 'https://api.githubcopilot.com', telemetry: 'https://telemetry.githubcopilot.com' },
        });
      return json(404, { message: 'Not Found' });
    }
    if (path === '/models') return json(200, { data: [MODEL], object: 'list' });
    if (path === '/models/session')
      return json(200, {
        session_token: 'e2e-auto',
        selected_model: { id: 'gpt-4.1' },
        available_models: ['gpt-4.1'],
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    if (path === '/auto')
      return json(200, { selected_model: { id: 'gpt-4.1' }, chosen_model: 'gpt-4.1', session_token: 'e2e-auto' });
    if (path !== '/chat/completions') return json(404, { message: 'not part of the fake' });
    const request = JSON.parse(body || '{}');
    const reply = decide(request);
    const id = `chatcmpl-${Date.now()}`;
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (reply.tool) {
      res.write(
        chunk({
          role: 'assistant',
          content: null,
          tool_calls: [
            { index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: reply.tool, arguments: '' } },
          ],
        }),
      );
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.args) } }] }));
      res.write(chunk({}, 'tool_calls'));
    } else {
      for (const part of reply.content.match(/.{1,12}/gs) ?? [''])
        res.write(chunk({ role: 'assistant', content: part }));
      res.write(chunk({}, 'stop'));
    }
    res.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  },
);
// Node's Keep-Alive header is not valid over HTTP/2, which the proxy speaks to the runtime.
server.keepAliveTimeout = 0;
server.listen(Number(process.env.E2E_PORT ?? 18443), '127.0.0.1', () => console.log('fake Copilot API ready'));
