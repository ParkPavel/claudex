# Configure Obsidian CLI acceptance

## Prerequisites

Install a desktop version with native CLI support and enable **Settings → General → Command
line interface**. Follow its registration instructions. Windows requires an installer that
includes the CLI redirector; updating only the in-app payload is not sufficient. Verify the
installed command with `obsidian version` and `obsidian help`.

See the authoritative [Obsidian CLI documentation](https://obsidian.md/help/cli). The adapter
probes actual commands instead of assuming that a version label proves capability.

## Local configuration

In the desktop's `.local/claudex/workspace.json`, set:

```json
{
  "executables": { "obsidian": "obsidian" },
  "obsidian": {
    "vault": "Your Test Vault",
    "vaultPath": "ABSOLUTE_LOCAL_VAULT_PATH",
    "testVault": true
  }
}
```

These fields are part of the existing local configuration; preserve its other values.
Keep production vaults out of automated mutation workflows. Claudex checks the actual
selected vault path before the operation. The fixed identity probe is read-only JavaScript;
arbitrary `eval` is classified as a mutation.

## Capture evidence

From the desktop directory:

```sh
node claudex/bin/claudex.mjs obsidian dev:errors
node claudex/bin/claudex.mjs obsidian dev:screenshot
node claudex/bin/claudex.mjs obsidian plugin:reload --params '{"id":"your-plugin"}' --write
```

The final example uses shell JSON quoting; on shells that transform quotes, use a script
calling the exported adapter with an object. Outputs are saved under local artifacts. The
command prints the evidence record and location, not the vault's returned note content.

For a complete acceptance run, record the source and bundle hashes, deploy to the test
vault, reload the plugin, perform the target action, inspect DOM/errors, then read persisted
state. Restart/reload and read again when durability is part of the criterion. A successful
CLI command is not by itself acceptance.

## Deliberate limits

The adapter exposes a bounded command set. Permanent delete, arbitrary command-palette
execution and plugin installation are not exposed. To add an operation, define its parameter
schema, classify mutation, test vault selection and capture evidence before documenting it.
REST credentials are not needed by the native CLI integration.
