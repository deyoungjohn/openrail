# Openrail server runbook: from nothing to a running site

One file, in order. Every step says where you run it:

- **[LAPTOP]** your machine (WSL), in the `openrail` folder unless the step says otherwise.
- **[EC2]** the server, after you `ssh` into it.
- **[BROWSER]** a web browser.

Do the steps in order. Do not skip ahead. Each step ends with a check that tells you it worked. If a check fails, stop and fix that step.

Names used below (replace the `<...>` parts once, here, and keep this list open):

| Placeholder   | Meaning                   | Example               |
| ------------- | ------------------------- | --------------------- |
| `<SERVER_IP>` | the EC2 public IP         | `52.79.253.146`       |
| `<KEYFILE>`   | your SSH private key file | `~/.ssh/openrail.pem` |

The contract is already deployed on mainnet. This runbook does not touch it.

---

## Part 1. Prepare on your laptop

### Step 1. [LAPTOP] Get the latest code and check your tools

```bash
cd ~/openrail
git checkout main && git pull
git status --short          # must print nothing
node --version              # must start with v22.23
pnpm --version
```

Check: `git status` prints nothing and Node is `v22.23.x`. If Node is a different version, the build refuses to run; install 22.23 with nvm (`nvm install 22.23.0 && nvm use 22.23.0`).

### Step 2. [LAPTOP] Create your env file (once)

Everything the scripts need lives in one file: `~/.openrail/openrail.env` (mode 600, folder mode 700). You never `export` a key in the terminal. Each script reads only the names it needs from this file.

Have these ready, then run the command. It asks five questions and copies the three private keys out of the keyring without printing them:

| It asks for                 | Where it comes from                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| EC2 public IP               | the AWS console                                                                                                             |
| SSH private key file        | for example `~/.ssh/openrail.pem`                                                                                           |
| WalletConnect project ID    | free at https://cloud.reown.com (create a project, copy its ID). Without it, HOT, OKX and Trust wallet login does not work. |
| 1Click JWT (hidden)         | your 1Click account                                                                                                         |
| NearBlocks API key (hidden) | your NearBlocks account (the free plan is enough)                                                                           |

```bash
./deploy/init-env.sh
```

It also generates the shared service key and the public pay-page key. Check that nothing is empty (this must print `ok`):

```bash
grep -n -E '^(ISSUER_SERVICE_KEY|ONECLICK_JWT|NEARBLOCKS_API_KEY|ISSUER_PRIVATE_KEY|RELAY_PRIVATE_KEY|WATCHER_PRIVATE_KEY|SERVER_IP|SSH_KEY_FILE|NEXT_PUBLIC_API_PUBLISHABLE_KEY|NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID)=$' ~/.openrail/openrail.env && echo "STILL EMPTY ABOVE: fix it with nano ~/.openrail/openrail.env" || echo ok
```

To change a value later, edit the file: `nano ~/.openrail/openrail.env`. It is not in the repository. Never paste it anywhere.

If `init-env.sh` stops with `MISSING_KEYRING_ITEM: <name>`, that key was never stored. Create it with `node tools/genkey.mjs` (in the lab repo) or tell me.

### Step 3. [LAPTOP] Build the server pack

The website bakes its public values (API address, network, contract, WalletConnect ID, pay-page key) in when it is built. The build reads them from your env file. Only names starting with `NEXT_PUBLIC_` are given to the build; the private keys are not.

```bash
./deploy/build.sh
```

This takes a few minutes. Check: it ends with `server pack ready: dist/openrail-server-<version>.tar.gz`.

## Part 2. First-time setup of the server (once)

### Step 4. [LAPTOP → EC2] Log in

```bash
ssh -i <KEYFILE> ubuntu@<SERVER_IP>
```

Everything in Part 2 and Part 4 is typed in this SSH window. Check: the prompt changes to `ubuntu@ip-...`.

### Step 5. [EC2] Check the machine type

```bash
uname -m
free -m
```

`uname -m` must print `x86_64`. If it prints `aarch64`, stop: the pack is built for x86 and will not run. Tell me and we rebuild for ARM.

### Step 6. [EC2] Packages, firewall and swap

```bash
sudo apt update
sudo apt install -y curl ca-certificates xz-utils gnupg sqlite3 fail2ban unattended-upgrades
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-openrail.conf
sudo sysctl --system
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo systemctl enable --now fail2ban
```

Ports 3000, 3001, 8080, 8787 and 8788 must stay closed to the outside (they are reached only from the server itself). Check: `sudo ufw status` lists only 22, 80 and 443.

### Step 7. [EC2] Lock down SSH (key-only login)

Before this step, keep your current SSH window open. SSH is allowed from any IP on purpose (your IP changes daily), which is only safe with key-only login:

```bash
sudo install -d -m 0755 /etc/ssh/sshd_config.d
printf '%s\n' 'PubkeyAuthentication yes' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' | sudo tee /etc/ssh/sshd_config.d/99-openrail.conf
sudo sshd -t && sudo systemctl reload ssh
```

Check: open a second terminal on your laptop and run the `ssh` command from Step 4 again. It must still let you in. If it does not, use the first window to undo the change (`sudo rm /etc/ssh/sshd_config.d/99-openrail.conf && sudo systemctl reload ssh`). Then run `sudo fail2ban-client status sshd` (it should say the jail is active).

### Step 8. [EC2] Install Node 22.23.0 and pnpm

```bash
cd ~
curl -fsSLO https://nodejs.org/dist/v22.23.0/node-v22.23.0-linux-x64.tar.xz
sudo tar -xJf node-v22.23.0-linux-x64.tar.xz -C /opt
sudo mv /opt/node-v22.23.0-linux-x64 /opt/node-22.23.0
for b in node npm npx corepack; do sudo ln -sfn /opt/node-22.23.0/bin/$b /usr/local/bin/$b; done
sudo /usr/local/bin/corepack enable --install-directory /usr/local/bin
sudo /usr/local/bin/corepack prepare pnpm@12.8.1 --activate
node --version
pnpm --version
```

Check: `v22.23.0` and `12.8.1`.

### Step 9. [EC2] Caddy, service users and folders

Caddy is already installed if the page "Caddy works!" showed on port 80. If not:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Then the users and folders:

```bash
sudo groupadd --system openrail
for name in web api watcher issuer indexer; do
  sudo useradd --system --gid openrail --home-dir /nonexistent --shell /usr/sbin/nologin "openrail-$name"
done
sudo install -d -m 0755 /opt/openrail/releases
sudo install -d -m 0750 -o root -g root /etc/openrail
sudo install -d -m 0770 -o root -g openrail /var/lib/openrail
sudo install -d -m 0700 -o root -g root /var/backups/openrail
```

Check: `ls -ld /etc/openrail /var/lib/openrail` shows both folders.

Leave the SSH window open, or type `exit` to come back to the laptop.

---

## Part 3. Upload from your laptop

### Step 10. [LAPTOP] Copy the pack and the env file to the server

```bash
./deploy/upload.sh --env
```

It uses `SERVER_IP` and `SSH_KEY_FILE` from your env file and copies the newest pack plus the env file to the server's home folder. Check: both files print 100% and no error.

---

## Part 4. Install and start on the server

Log in again if you left: `ssh -i <KEYFILE> ubuntu@<SERVER_IP>`.

### Step 11. [EC2] Unpack the pack

```bash
version="$(ls -t ~/openrail-server-*.tar.gz | head -1 | sed 's/.*openrail-server-\(.*\)\.tar\.gz/\1/')"
echo "installing $version"
sudo mkdir -p "/opt/openrail/releases/$version"
sudo tar -xzf ~/openrail-server-$version.tar.gz -C "/opt/openrail/releases/$version"
sudo chown -R root:openrail "/opt/openrail/releases/$version"
sudo chmod -R g+rX "/opt/openrail/releases/$version"
sudo chown -R openrail-web:openrail "/opt/openrail/releases/$version/services/web/.next"
sudo install -d -m 0770 -o openrail-watcher -g openrail "/opt/openrail/releases/$version/reports"
sudo ln -sfn "/opt/openrail/releases/$version" /opt/openrail/current
ls /opt/openrail/current
```

Check: the last command lists `deploy packages services config node_modules` and more.

### Step 12. [EC2] Split the env file into one file per service

Each service gets only its own settings, so the public API can never read the private keys.

```bash
chmod 600 ~/openrail.env
sudo /opt/openrail/current/deploy/split-env.sh ~/openrail.env
shred -u ~/openrail.env
sudo ls -l /etc/openrail
```

Check: five files (`api.env issuer.env watcher.env indexer.env web.env`), each `-rw-------` owned by `root`. Lines like `not set: EVM_RPC_URL` are fine; they are optional.

### Step 13. [EC2] Install the services and the web server config, then start

```bash
sudo install -m 0644 /opt/openrail/current/deploy/systemd/*.service /opt/openrail/current/deploy/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openrail-indexer.service openrail-issuer.service openrail-watcher.service openrail-api.service openrail-web.service openrail-backup.timer
sudo install -m 0644 /opt/openrail/current/deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### Step 14. [EC2] Check that everything runs

```bash
sleep 20
sudo /opt/openrail/current/deploy/healthcheck.sh
```

Check: it ends with `all checks passed`. If a line says `FAIL openrail-<name>`, read why:

```bash
sudo journalctl -u openrail-<name> -n 60 --no-pager
```

Copy the last lines (they never contain keys) and send them to me. Do not continue until the check passes.

---

## Part 5. Register the pay-page key

### Step 15. [EC2] Register the pay-page key with the API

The key is in the env file you uploaded and split in Step 12, but only the website build needs it; the API needs to know it. The env file was deleted in Step 12 on purpose, so read the key from your laptop. [LAPTOP]:

```bash
grep '^NEXT_PUBLIC_API_PUBLISHABLE_KEY=' ~/.openrail/openrail.env
```

Copy the part after `=` (it starts with `or_pk_live_`; it is public by design). Then [EC2], replacing `<THE KEY>`:

```bash
cd /opt/openrail/current
echo '<THE KEY>' | sudo -u openrail-api env DATABASE_URL=/var/lib/openrail/api.sqlite NEAR_ROOT_ACCOUNT=openrail.near /usr/local/bin/pnpm --filter @openrail/api register-pk
```

Check: it prints `registered publishable key` (or `this key was already registered`).

---

## Part 6. Verify from outside

### Step 16. [LAPTOP] Test the public addresses

```bash
curl -s https://api.openrail.incepture.dev/v1/health
curl -s -o /dev/null -w "web: %{http_code}\n" https://openrail.incepture.dev/
```

Check: the first prints JSON with an OK status; the second prints `web: 200`. The first request may take a few seconds while Caddy gets the HTTPS certificate. If it still fails after two minutes: `sudo journalctl -u caddy -n 40 --no-pager` on the server.

### Step 17. [BROWSER] Sign in

Open https://openrail.incepture.dev, choose a NEAR wallet, and sign in (the session should survive a page reload). If sign-in works, the website, API and chain connection work.

### Step 18. Tell me it is up

Send me the output of Step 14 and Step 16. I check the API from outside and then we run the mainnet run (`pnpm t2:g1`, dry run first).

---

## Updating later (until the one-command updater exists)

Whenever the code changes:

1. [LAPTOP] `cd ~/openrail && git pull && ./deploy/build.sh && ./deploy/upload.sh`
2. [EC2] Run Step 11 again (it picks the newest pack by itself), then:

```bash
sudo systemctl restart openrail-indexer openrail-issuer openrail-watcher openrail-api openrail-web
sleep 20 && sudo /opt/openrail/current/deploy/healthcheck.sh
```

To go back to the previous version, point the link at the old folder and restart:

```bash
ls /opt/openrail/releases
sudo ln -sfn /opt/openrail/releases/<OLD_COMMIT> /opt/openrail/current
sudo systemctl restart openrail-indexer openrail-issuer openrail-watcher openrail-api openrail-web
```

If a setting changed: edit `~/.openrail/openrail.env`, run `./deploy/upload.sh --env`, then on the server Step 12 and the restart line. Settings that start with `NEXT_PUBLIC_` need a new build as well.

## If something goes wrong

| Symptom                                 | Do this                                                                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uname -m` is `aarch64`                 | Stop. The pack is for x86 servers.                                                                                                                          |
| `FAIL openrail-api.service`             | `sudo journalctl -u openrail-api -n 60 --no-pager`; a line starting `MISSING_ENV:` names the missing setting; add it to the combined file and redo Step 12. |
| HTTPS does not work                     | DNS records must be "DNS only" (grey cloud) in Cloudflare; ports 80 and 443 must be open in the AWS security group and `ufw`.                               |
| Pay page says it cannot start a payment | The publishable key was not registered (Step 15) or the web pack was built without it (Step 3).                                                             |
| Receipts do not appear                  | The indexer polls every 5 minutes to stay inside the NearBlocks free plan. Wait, or check `sudo journalctl -u openrail-indexer -n 40 --no-pager`.           |
| You changed a `NEXT_PUBLIC_*` value     | It only takes effect after a new build (Step 3) and upload.                                                                                                 |
