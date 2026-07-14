// ABOUTME: Defines one agent-readable command catalogue and renders equivalent human help.
// ABOUTME: Parses root and focused help before strict command argument parsing runs.

export interface HelpField {
  syntax: string;
  description: string;
}

export interface CommandHelp {
  name: HelpCommandName;
  summary: string;
  usage: string;
  arguments: HelpField[];
  options: HelpField[];
  examples: string[];
  notes: string[];
}

export type HelpCommandName = 'login' | 'init' | 'deploy' | 'auth status' | 'logout';

export interface RootHelpValue extends Record<string, unknown> {
  helpVersion: 1;
  cli: 'drops';
  summary: string;
  quickStart: string[];
  commands: CommandHelp[];
}

export interface CommandHelpValue extends Record<string, unknown> {
  helpVersion: 1;
  cli: 'drops';
  command: CommandHelp;
}

export interface HelpRequest {
  command?: HelpCommandName;
}

const SUMMARY = 'Publish local files, folders, and zip archives to authenticated Drops instances.';

const QUICK_START = [
  'drops login https://drops.example.com',
  'drops init --instance https://drops.example.com',
  'drops deploy ./dist --name preview',
];

const COMMANDS: CommandHelp[] = [
  {
    name: 'login',
    summary: 'Authorise this Mac for one exact Drops instance using the browser.',
    usage: 'drops login <origin> [--json]',
    arguments: [{ syntax: '<origin>', description: 'Exact HTTPS app origin, such as https://drops.example.com.' }],
    options: [
      { syntax: '--json', description: 'Write exactly one machine-readable result to stdout.' },
      { syntax: '--help', description: 'Show this command help.' },
    ],
    examples: [
      'drops login https://drops.example.com',
      'drops login https://drops.other.example --json',
    ],
    notes: [
      'The browser URL is also printed for copy and paste.',
      'Credentials are stored in macOS Keychain separately for each exact origin.',
    ],
  },
  {
    name: 'init',
    summary: 'Save a secret-free default Drops instance in the current repository.',
    usage: 'drops init --instance <origin> [--force] [--json]',
    arguments: [],
    options: [
      { syntax: '--instance <origin>', description: 'Exact HTTPS app origin to write to .drops.json.' },
      { syntax: '--force', description: 'Replace an existing .drops.json file.' },
      { syntax: '--json', description: 'Write exactly one machine-readable result to stdout.' },
      { syntax: '--help', description: 'Show this command help.' },
    ],
    examples: [
      'drops init --instance https://drops.example.com',
      'drops init --instance https://drops.other.example --force',
    ],
    notes: ['Commit .drops.json if agents in the repository should share this default instance.'],
  },
  {
    name: 'deploy',
    summary: 'Package and atomically publish one local file, folder, or zip archive.',
    usage: 'drops deploy <path> --name <name> [--instance <origin>] [--json]',
    arguments: [{ syntax: '<path>', description: 'Local file, directory, or zip archive to publish.' }],
    options: [
      { syntax: '--name <name>', description: 'Required stable drop slug; redeploying replaces it atomically.' },
      { syntax: '--instance <origin>', description: 'Override the nearest repository .drops.json instance.' },
      { syntax: '--json', description: 'Write exactly one machine-readable result to stdout.' },
      { syntax: '--help', description: 'Show this command help.' },
    ],
    examples: [
      'drops deploy ./dist --name preview',
      'drops deploy ./storybook-static --name design-system --instance https://drops.other.example',
      'drops deploy ./site.zip --name release --json',
    ],
    notes: [
      'Run drops login <origin> before the first deployment to an instance.',
      '--instance takes precedence over the repository default.',
    ],
  },
  {
    name: 'auth status',
    summary: 'Check whether the selected instance credential is present and valid.',
    usage: 'drops auth status [origin] [--instance <origin>] [--json]',
    arguments: [{ syntax: '[origin]', description: 'Optional exact instance origin.' }],
    options: [
      { syntax: '--instance <origin>', description: 'Select an instance instead of repository configuration.' },
      { syntax: '--json', description: 'Write exactly one machine-readable result to stdout.' },
      { syntax: '--help', description: 'Show this command help.' },
    ],
    examples: [
      'drops auth status',
      'drops auth status https://drops.example.com',
      'drops auth status --instance https://drops.other.example --json',
    ],
    notes: ['A revoked credential is removed from Keychain when the server reports it invalid.'],
  },
  {
    name: 'logout',
    summary: 'Revoke and remove the credential for one exact Drops instance.',
    usage: 'drops logout [origin] [--instance <origin>] [--json]',
    arguments: [{ syntax: '[origin]', description: 'Optional exact instance origin.' }],
    options: [
      { syntax: '--instance <origin>', description: 'Select an instance instead of repository configuration.' },
      { syntax: '--json', description: 'Write exactly one machine-readable result to stdout.' },
      { syntax: '--help', description: 'Show this command help.' },
    ],
    examples: [
      'drops logout',
      'drops logout https://drops.example.com',
      'drops logout --instance https://drops.other.example --json',
    ],
    notes: ['The server token is revoked before the local Keychain item is deleted.'],
  },
];

function commandNamed(value: string): HelpCommandName | undefined {
  return COMMANDS.find((command) => command.name === value)?.name;
}

function command(value: HelpCommandName): CommandHelp {
  return COMMANDS.find((candidate) => candidate.name === value)!;
}

export function parseHelpRequest(argv: string[]): HelpRequest | null {
  const args = argv.filter((argument) => argument !== '--json');
  if (args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === 'help'))) return {};

  let commandTokens: string[] | null = null;
  if (args[0] === 'help') commandTokens = args.slice(1);
  else if (args.at(-1) === '--help') commandTokens = args.slice(0, -1);
  if (commandTokens === null) return null;

  const name = commandNamed(commandTokens.join(' '));
  return name === undefined ? null : { command: name };
}

export function rootHelpValue(): RootHelpValue {
  return { helpVersion: 1, cli: 'drops', summary: SUMMARY, quickStart: [...QUICK_START], commands: COMMANDS };
}

export function commandHelpValue(name: HelpCommandName): CommandHelpValue {
  return { helpVersion: 1, cli: 'drops', command: command(name) };
}

function renderFields(title: string, fields: HelpField[]): string[] {
  if (fields.length === 0) return [];
  return [title, ...fields.map((field) => `  ${field.syntax.padEnd(22)} ${field.description}`), ''];
}

export function renderRootHelp(): string {
  return [
    'Drops CLI',
    SUMMARY,
    '',
    'Usage: drops <command> [options]',
    '',
    'Quick start:',
    ...QUICK_START.map((example) => `  ${example}`),
    '',
    'Commands:',
    ...COMMANDS.map((item) => `  ${item.name.padEnd(12)} ${item.summary}`),
    '',
    'Run drops <command> --help for command details.',
    'For machine-readable help: drops help --json',
  ].join('\n');
}

export function renderCommandHelp(name: HelpCommandName): string {
  const item = command(name);
  return [
    `drops ${item.name} — ${item.summary}`,
    '',
    `Usage: ${item.usage}`,
    '',
    ...renderFields('Arguments:', item.arguments),
    ...renderFields('Options:', item.options),
    'Examples:',
    ...item.examples.map((example) => `  ${example}`),
    '',
    'Notes:',
    ...item.notes.map((note) => `  ${note}`),
  ].join('\n');
}
