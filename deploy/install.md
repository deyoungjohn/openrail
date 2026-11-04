# Server install

The server steps now live in one file, in order, with every step marked as [LAPTOP], [EC2] or [BROWSER]:

**[deploy/RUNBOOK.md](RUNBOOK.md)**

The combined env template is `deploy/env/openrail.env.example`; `deploy/split-env.sh` turns it into one file per service.
