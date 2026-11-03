# Server pack for the EC2 host

The host runs the built pack only. Never run `pnpm build`, `cargo`, or `deploy/build.sh` on the server: the host has 2 GB RAM and no build toolchain.

## 1. Base host

Ubuntu 24.04 LTS, x86_64, 2 GB RAM or more. Apply:

```bash
sudo apt update
sudo apt install -y curl ca-certificates xz-utils gnupg debian-keyring debian-archive-keyring apt-transport-https
```

Put swap pressure low and persist it:

```bash
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-openrail.conf
sudo sysctl --system
```

Open only SSH, HTTP, and HTTPS:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Ports `3000`, `3001`, `8080`, and `8787` stay private on loopback; never add firewall rules for them.

## 2. Node 22.23.0 and pnpm 12.8.1

Install the pinned Node tarball outside the home directories so the non-login service users can reach it:

```bash
curl -fsSLO https://nodejs.org/dist/v22.23.0/node-v22.23.0-linux-x64.tar.xz
sudo tar -xJf node-v22.23.0-linux-x64.tar.xz -C /opt
sudo mv /opt/node-v22.23.0-linux-x64 /opt/node-22.23.0
sudo ln -sfn /opt/node-22.23.0/bin/node /usr/local/bin/node
sudo ln -sfn /opt/node-22.23.0/bin/npm /usr/local/bin/npm
sudo ln -sfn /opt/node-22.23.0/bin/npx /usr/local/bin/npx
sudo ln -sfn /opt/node-22.23.0/bin/corepack /usr/local/bin/corepack
sudo /usr/local/bin/corepack enable --install-directory /usr/local/bin
sudo /usr/local/bin/corepack prepare pnpm@12.8.1 --activate
/usr/local/bin/node --version   # v22.23.0
/usr/local/bin/pnpm --version   # 12.8.1
```

## 3. Caddy

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

DNS: point `openrail.incepture.dev` and `api.openrail.incepture.dev` at this host before starting Caddy.

## 4. Users, directories, and the pack

```bash
sudo groupadd --system openrail
for name in web api watcher issuer indexer; do
  sudo useradd --system --gid openrail --home-dir /nonexistent --shell /usr/sbin/nologin "openrail-$name"
done

sudo install -d -m 0755 /opt/openrail/releases
sudo install -d -m 0750 -o root -g openrail /etc/openrail
sudo install -d -m 0770 -o root -g openrail /var/lib/openrail
```

On the developer machine:

```bash
./deploy/build.sh
# dist/openrail-server-<commit>.tar.gz
```

Copy that tarball to the server, then:

```bash
version="<commit>"
sudo mkdir -p "/opt/openrail/releases/$version"
sudo tar -xzf "openrail-server-$version.tar.gz" -C "/opt/openrail/releases/$version"
sudo chown -R root:openrail "/opt/openrail/releases/$version"
sudo chmod -R g+rX "/opt/openrail/releases/$version"
sudo chown -R openrail-web:openrail "/opt/openrail/releases/$version/services/web/.next"
sudo install -d -m 0770 -o openrail-watcher -g openrail "/opt/openrail/releases/$version/reports"
sudo ln -sfn "/opt/openrail/releases/$version" /opt/openrail/current
```

## 5. Environment

```bash
sudo install -m 0640 -o root -g openrail \
  /opt/openrail/current/deploy/env.example /etc/openrail/env
sudo editor /etc/openrail/env
```

Fill every value that the services need. Never commit or paste the filled file. Required for the API and issuer: `NEAR_ROOT_ACCOUNT`, `NEAR_RPC_URL`, `ISSUER_URL=http://127.0.0.1:8787`, `ISSUER_SERVICE_KEY`, `ISSUER_ACCOUNT_ID`, `ISSUER_PRIVATE_KEY`, `RELAY_PRIVATE_KEY`, `DATABASE_URL=/var/lib/openrail/api.sqlite`, `WEB_ORIGIN=https://openrail.incepture.dev`, `COOKIE_DOMAIN=openrail.incepture.dev`.

`NEXT_PUBLIC_*` values are baked by `deploy/build.sh`; changing them needs a new pack.

## 6. Units and Caddy

```bash
sudo install -m 0644 /opt/openrail/current/deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openrail-web.service openrail-api.service openrail-watcher.service openrail-issuer.service

sudo install -m 0644 /opt/openrail/current/deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

`openrail-indexer.service` is installed but not enabled until the indexer entrypoint lands. Then:

```bash
sudo systemctl enable --now openrail-indexer.service
```

## 7. Log rotation

Services write to journald. Cap it and keep Caddy in the same journal:

```bash
sudo install -d /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\nSystemKeepFree=1G\nRuntimeMaxUse=100M\n' \
  | sudo tee /etc/systemd/journald.conf.d/99-openrail.conf
sudo systemctl restart systemd-journald
sudo journalctl --vacuum-size=500M
```

## 8. Health

```bash
sudo /opt/openrail/current/deploy/healthcheck.sh
```

It checks web `:3000`, API `:3001/health`, watcher `:8080/health`, issuer `:8787/health`, the four units, Caddy, and the indexer when enabled. Exit code is non-zero on any failure.

For a one-minute timer, add:

```bash
sudo tee /etc/systemd/system/openrail-healthcheck.service >/dev/null <<'EOF'
[Unit]
Description=Openrail local health check
After=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/openrail/current/deploy/healthcheck.sh
EOF
sudo tee /etc/systemd/system/openrail-healthcheck.timer >/dev/null <<'EOF'
[Unit]
Description=Run the Openrail health check every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now openrail-healthcheck.timer
```

## 9. Release updates

Build and copy a new tarball, extract it to a new `/opt/openrail/releases/<commit>`, set the same ownership, flip `/opt/openrail/current`, then:

```bash
sudo systemctl restart openrail-web.service openrail-api.service openrail-watcher.service openrail-issuer.service
sudo /opt/openrail/current/deploy/healthcheck.sh
```

No build runs on the server.
