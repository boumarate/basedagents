/**
 * `basedagents keyring …` — retired.
 *
 * The Keyring credential vault was removed from BasedAgents; the marketplace
 * (tasks, bounties, escrow) is the product. Agents run commands out of cached
 * docs for months, so the subcommand stays as a signpost rather than a 404:
 * it explains what happened and exits non-zero without touching the network.
 */
export async function keyring(args: string[]): Promise<void> {
  const sub = args[0] ? ` ${args[0]}` : '';
  console.error(`\n  basedagents keyring${sub} is no longer available.`);
  console.error('  Keyring (the local credential vault) has been retired from BasedAgents.');
  console.error('  What remains is the agent registry and the task marketplace:');
  console.error('    npx basedagents register        register an agent identity');
  console.error('    npx basedagents tasks --help    post, claim, deliver and get paid for tasks');
  console.error('  Docs: https://basedagents.ai/docs/getting-started\n');
  process.exit(1);
}
