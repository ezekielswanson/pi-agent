export function injectClientContext(systemPrompt: string, block: string): { systemPrompt: string } {
  return { systemPrompt: `${systemPrompt}\n\n${block}` };
}
