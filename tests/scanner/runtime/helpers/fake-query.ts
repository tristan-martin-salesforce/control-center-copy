/** A fake `query()` that plays the CLI: calls the PreToolUse hook, runs cc tools on the real in-process MCP server. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../../../../src/llm/skill-runner';

export type Step =
  | { tool: string; input: Record<string, unknown>; viaHook?: boolean }
  | { usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };

export interface FakeOpts {
  steps: Step[];
  mcpStatus?: string;
  result?: Partial<Record<string, unknown>>;
}

export function fakeQuery(o: FakeOpts, seen: { options?: Options; prompt?: string; toolResults: string[] }): QueryFn {
  return ({ prompt, options }) => {
    seen.options = options;
    seen.prompt = prompt;
    const gen = async function* (): AsyncGenerator<SDKMessage> {
      const signal = options.abortController!.signal;
      const cc = (options.mcpServers as any).cc.instance;
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await cc.connect(st);
      const client = new Client({ name: 'fake-cli', version: '1' });
      await client.connect(ct);
      yield { type: 'system', subtype: 'init', mcp_servers: [{ name: 'slack', status: o.mcpStatus ?? 'connected' }, { name: 'cc', status: 'connected' }], tools: [...(options.allowedTools ?? [])] } as any;
      let n = 0;
      for (const step of o.steps) {
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        n += 1;
        if ('usage' in step) {
          yield { type: 'assistant', message: { id: `msg_${n}`, model: options.model, content: [{ type: 'text', text: '' }], usage: step.usage } } as any;
          continue;
        }
        yield { type: 'assistant', message: { id: `msg_${n}`, model: options.model, content: [{ type: 'tool_use', id: `tu_${n}`, name: step.tool, input: step.input }], usage: { input_tokens: 50, output_tokens: 40, cache_read_input_tokens: 3000 } } } as any;
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (step.viaHook !== false) {
          const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
          const out: any = await hook({ hook_event_name: 'PreToolUse', tool_name: step.tool, tool_input: step.input, tool_use_id: `tu_${n}`, session_id: 's', transcript_path: '', cwd: '' } as any, `tu_${n}`, { signal });
          if (out?.hookSpecificOutput?.permissionDecision === 'deny') continue;
        }
        if (step.tool.startsWith('mcp__cc__')) {
          const r: any = await client.callTool({ name: step.tool.slice('mcp__cc__'.length), arguments: step.input });
          seen.toolResults.push(r.content?.[0]?.text ?? '');
        }
      }
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: n,
        result: 'DONE',
        total_cost_usd: 0.0031,
        usage: { input_tokens: 100, output_tokens: 200 },
        modelUsage: { 'claude-haiku-5-5': { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 6000, cacheCreationInputTokens: 2500, webSearchRequests: 0, costUSD: 0.0031, contextWindow: 1, maxOutputTokens: 1 } },
        permission_denials: [],
        ...o.result,
      } as any;
      await client.close();
    };
    return gen();
  };
}

