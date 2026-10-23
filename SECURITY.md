# Security

Agents can run JavaScript written by the AI inside a Node `vm` sandbox. A `vm` is not a security boundary, so:

- run agents only on machines and worlds you trust;
- never give an agent operator rights on a public server;
- keep your API key in `.env`, which is ignored by git.

To report a vulnerability, open a private security advisory on GitHub (**Security → Report a vulnerability**) instead of a public issue.
