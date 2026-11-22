# Security policy

## Supported versions

Only the latest version published on the VS Code Marketplace and Open VSX receives security fixes.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting instead:
[Security › Report a vulnerability](https://github.com/jstrullu/readable-tests/security/advisories/new).

Please include the affected version, the steps to reproduce and the impact you observed.
You should get a first answer within a week. This is a personal open-source project: fixes are handled on a best-effort basis, and you will be credited in the advisory unless you prefer otherwise.

## Scope

Readable Tests runs local tools on your behalf: `dotnet build`, `dotnet test`, your test binaries, and the project's own Vitest, Jest or Angular CLI through `node`, with the reporters shipped in the extension. It is **disabled in untrusted workspaces** for that reason.

In scope, for example:

- running a command or executable that the workspace did not configure, or bypassing workspace trust;
- injection through test names, file paths, test output or stack traces (command line, webview HTML);
- the webview executing script content coming from test results.

Out of scope: vulnerabilities in the .NET SDK, Node.js, the test frameworks themselves, or in code that your own tests execute.
