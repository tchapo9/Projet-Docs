# Lumen Docs

**Lumen Docs** est une application web d'édition de documents collaborative en temps réel avec :
- **Éditeur temps réel** propulsé par **Etherpad v3.3.3**
- **Appels vidéo/audio** WebRTC intégrés
- **Gestion de permissions** granulaire (owner, editor, commenter, viewer)
- **Backend API** Express.js + MySQL + JWT
- **Frontend** TanStack Start + React 19 + Tailwind CSS v4

---

## Architecture

```
lumen/
├── back_docs/          # Backend API (Express.js + MySQL + JWT)
├── front_docs/         # Frontend (TanStack Start + React 19 + Tailwind CSS v4)
├── etherpad-3.3.3/     # Etherpad v3.3.3 (éditeur collaboratif temps réel)
```

### Stack technique

| Composant          | Technologie |
|--------------------|-------------|
| **Frontend**       | TanStack Start (React 19) + Tailwind CSS v4 + shadcn/ui |
| **Backend API**    | Express.js 5 + MySQL (mysql2) + JWT (jsonwebtoken) |
| **Éditeur collaboratif** | Etherpad v3.3.3 (API HTTP + WebSocket) |
| **Authentification** | JWT (jsonwebtoken) + bcryptjs |
| **Base de données** | MySQL 8 (utf8mb4) |
| **Temps réel** | Socket.io (WebRTC signaling) + PeerJS (WebRTC mesh) |
| **Stockage objet** | MinIO (S3-compatible) |
| **Reverse proxy / TLS** | Nginx |
| **Process manager** | PM2 (backend) + systemd (Etherpad) |

---

## Fonctionnalités

| Fonctionnalité | Description |
|----------------|-------------|
| **Édition collaborative** | Temps réel via Etherpad (pads, curseurs, couleurs, chat) |
| **Appels vidéo/audio** | WebRTC mesh via PeerJS + Socket.io signaling |
| **Gestion de permissions** | owner / editor / commenter / viewer + `can_share` |
| **Documents publics/privés** | Toggle public/privé, partage par email |
| **Appels vidéo/audio** | WebRTC mesh (PeerJS + Socket.io signaling) |
| **Présence temps réel** | Curseurs, utilisateurs en ligne, heartbeat |
| **Exports** | HTML, PDF, TXT, DOCX via Etherpad |
| **Stockage objet** | MinIO (exports, avatars, pièces jointes) |
| **Authentification** | JWT + bcrypt (local) + OAuth ready |

---

## Structure du projet

```
lumen/
├── back_docs/                    # Backend API (Express.js)
│   ├── package.json
│   ├── .env                      # Variables d'environnement (voir ci-dessous)
│   ├── server/
│   │   ├── index.cjs             # Point d'entrée : Express + Socket.io + PeerJS
│   │   ├── db.cjs                # Pool MySQL (mysql2)
│   │   ├── auth.cjs              # JWT (sign/verify) + middleware
│   │   ├── etherpad.cjs          # Wrapper API Etherpad
│   │   ├── presence.cjs          # Présence temps réel (document_sessions)
│   │   ├── permission.service.cjs # Logique rôles (ROLE_LEVELS, canEdit...)
│   │   ├── schema.sql            # Schéma MySQL
│   │   ├── middleware/
│   │   │   └── permissions.cjs   # loadDocument + requirePermission(...)
│   │   └── routes/
│   │       ├── auth.cjs          # /api/auth/* (register, login, me, search)
│   │   └── docs.cjs              # CRUD docs, partage, exports, etherpad-url
│   ├── schema.sql                # Schéma MySQL complet
│   └── tests/
│       └── permissions.test.cjs
│
├── front_docs/                   # Frontend (TanStack Start + React 19)
│   ├── package.json
│   ├── .env                      # VITE_API_URL=https://<host>
│   ├── src/
│   │   ├── routes/               # File-based routing (TanStack Router)
│   │   │   ├── __root.tsx        # Layout principal
│   │   │   ├── index.tsx         # Landing + Workspace
│   │   │   ├── login.tsx / register.tsx
│   │   │   └── doc.$docId.tsx    # Éditeur (iframe Etherpad + CallPanel)
│   │   ├── components/           # UI components (shadcn/ui + custom)
│   │   ├── lib/                  # API client, auth, hooks
│   │   └── styles.css            # Tailwind + custom
│   ├── vite.config.ts            # Config Vite + TanStack Router
│   └── tsconfig.json
│
├── etherpad-3.3.3/               # Etherpad v3.3.3 (forké/customisé)
│   ├── settings.json             # Config Etherpad (port 9001, APIKEY, etc.)
│   ├── APIKEY.txt                # Clé API (réf. ETHERPAD_APIKEY)
│   ├── src/
│   │   ├── node/                 # Code serveur (hooks, handlers, webaccess)
│   │   ├── static/               # Assets client (JS/CSS/skins)
│   │   └── static/custom/etherpad.css  # CSS custom (indigo #4f46e5)
│   ├── settings.json             # Config principale (port 9001, DB SQLite)
│   └── var/                      # Données runtime (SQLite pads)
```

---

## Prérequis

- **Node.js** ≥ 20
- **MySQL** 8.0+ (utf8mb4)
- **MinIO** (optionnel, pour stockage objet)
- **Nginx** (reverse proxy + TLS)
- **PM2** (backend) + **systemd** (Etherpad)

---

## Installation

### 1. Cloner le projet

```bash
git clone <repo-url> lumen
cd lumen
```

### 2. Backend (back_docs)

```bash
cd back_docs
npm install
```

#### Base de données MySQL

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS lumen_docs CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p -e "CREATE USER IF NOT EXISTS 'lumen_docs'@'localhost' IDENTIFIED BY 'Passer123/';"
mysql -u root -p -e "GRANT ALL PRIVILEGES ON lumen_docs.* TO 'lumen_docs'@'localhost';"
mysql -u root -p -e "FLUSH PRIVILEGES;"
mysql -u lumen_docs -p'Passer123/' lumen_docs < server/schema.sql
```

#### Variables d'environnement (`.env`)

```env
PORT=3001

# PostgreSQL -> MySQL
DB_HOST=localhost
DB_PORT=3306
DB_USER=lumen_docs
DB_PASSWORD=Passer123/
DB_NAME=lumen_docs

# JWT
JWT_SECRET=changez_ce_secret_en_production

# Etherpad
ETHERPAD_URL=http://127.0.0.1:9001
ETHERPAD_PUBLIC_URL=https://<votre-domaine>
ETHERPAD_APIKEY=d737cfca033be65cdd4cdf2401249f1c3593b35a0890cc9287fa9b4c011e9325

# MinIO (optionnel)
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=lumen-docs
MINIO_USE_SSL=false
MINIO_PUBLIC_URL=http://localhost:9000

# PeerJS / Socket.io
PEERJS_PORT=9000
SOCKET_IO_PORT=3001

# CORS
FRONTEND_ORIGIN=https://<votre-domaine>:8080
```

> ⚠️ Le code lit `DB_PASSWORD` (et non `DB_PASSWORD` au singulier dans l'ancien code). Vérifiez que la variable s'appelle bien `DB_PASSWORD`.

#### Lancer le backend

```bash
# Développement
npm run dev          # Lance backend + Vite dev (concurrently)

# Production
pm2 start server/index.cjs --name lumen-docs-api
pm2 save
```

---

### 3. Etherpad (etherpad-3.3.3)

Etherpad v3.3.3 est installé dans `etherpad-3.3.3/` et tourne sur le port **9001**.

```bash
cd etherpad-3.3.3
npm install
```

#### Configuration (`settings.json`)

Les points clés dans `settings.json` :

```json
{
  "port": 9001,
  "ip": "0.0.0.0",
  "dbType": "sqlite",
  "dbSettings": { "filename": "var/etherpad.db" },
  "requireAuthentication": false,
  "requireAuthorization": false,
  "trustProxy": true,
  "skinName": "colibris",
  "skinVariants": "super-light-toolbar super-light-editor light-background",
  "trustProxy": true,
  "publicURL": "https://<votre-domaine>",
  "minify": true,
  "maxAge": 21600,
  "requireAuthentication": false,
  "requireAuthorization": false,
  "trustProxy": true,
  "skinName": "colibris",
  "minify": true,
  "maxAge": 21600,
  "docupdate": false,
  "defaultPadText": "",
  "requireSession": false,
  "editOnly": false,
  "minify": true,
  "maxAge": 21600,
  "publicURL": "https://<votre-domaine>"
}
```

- La clé API se trouve dans `APIKEY.txt` (référencée par `ETHERPAD_APIKEY` dans le backend).
- CSS custom : `src/static/custom/etherpad.css` (importé par le skin colibris).

#### Lancer Etherpad (dev)

```bash
cd etherpad-3.3.3
npm run dev          # Mode dev (recompilation à la volée)
```

#### Production (systemd)

```bash
sudo systemctl restart etherpad
systemctl status etherpad
journalctl -u etherpad -n 50 -f
```

---

### 4. Frontend (front_docs)

```bash
cd front_docs
npm install
```

#### Variables d'environnement (`.env`)

```env
VITE_API_URL=https://<votre-domaine>
```

#### Lancer

```bash
# Développement
npm run dev          # Vite dev server sur http://localhost:8080

# Production
npm run build
npm run preview      # ou servir dist/ via Nginx
```

---

## Déploiement Production

### Architecture Nginx (Reverse Proxy + TLS)

Un seul vhost Nginx sur le port **443** (TLS) qui route :

| URI | Cible | Description |
|-----|-------|-------------|
| `/api/*` | `http://127.0.0.1:3001` | Backend API REST |
| `/signal` | `http://127.0.0.1:3001` | Socket.io (WebRTC signaling) |
| `/peerjs` | `http://127.0.0.1:3001` | PeerJS (WebRTC mesh) |
| `/p/*` | `http://127.0.0.1:9001` | Pads Etherpad + exports |
| `/watch/*` | `http://127.0.0.1:9001` | Bundles JS Etherpad (dev) |
| `/static/*` | `http://127.0.0.1:9001` | Assets Etherpad (cache 30j) |
| `/ep-api/*` | `http://127.0.0.1:9001` | API Etherpad (ex: checkToken) |
| `/` | `http://127.0.0.1:8080` | Frontend Vite dev / build |

**Points clés Nginx :**
- WebSocket : `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` sur `/signal`, `/peerjs`, `/p/*`, `/`
- CORS : géré par le backend (header `Access-Control-Allow-Origin`)
- CORS Etherpad : bloc `location /p/` avec `proxy_cache off` pour query strings
- Assets statiques : cache immuable 30j (`Cache-Control: public, max-age=2592000, immutable`)

### Certificats TLS

```bash
# Auto-signé (dev)
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/lumen.key \
  -out /etc/nginx/ssl/lumen.crt \
  -subj "/CN=lumen.local"

# Production : Let's Encrypt
certbot --nginx -d votre-domaine.com
```

### Certificats Backend (auto-signés dev)

```bash
cd back_docs
npm run gen-cert    # Génère certs/key.pem + certs/cert.pem
```

---

## Services Systemd

### Backend (PM2)

```bash
# /etc/systemd/system/lumen-backend.service
[Unit]
Description=Lumen Docs Backend
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/home/tchapo/lumen/back_docs
ExecStart=/usr/bin/node server/index.cjs
Restart=always
RestartSec=2
Environment=NODE_ENV=production
Environment=PATH=/root/.nvm/versions/node/v24.19.0/bin:/usr/bin:/bin
User=root
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lumen-backend
sudo systemctl status lumen-backend
sudo journalctl -u lumen-backend -f
```

### Frontend (systemd + Vite dev)

```bash
# /etc/systemd/system/lumen-frontend.service
[Unit]
Description=Lumen Docs Frontend (Vite Dev)
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/tchapo/lumen/front_docs
ExecStart=/root/.nvm/versions/node/v24.19.0/bin/node start-vite.cjs
Restart=always
RestartSec=5
Environment=NODE_ENV=development
Environment=PATH=/root/.nvm/versions/node/v24.19.0/bin:/usr/bin:/bin
User=root
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### Etherpad (systemd)

```bash
# /etc/systemd/system/etherpad.service
[Unit]
Description=Etherpad Lite
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/tchapo/lumen/etherpad-3.3.3
ExecStart=/root/.nvm/versions/node/v24.19.0/bin/npm run dev
Restart=always
RestartSec=5
Environment=NODE_ENV=development
User=root

[Install]
WantedBy=multi-user.target
```

---

## Commandes Utiles

```bash
# Backend
sudo systemctl status lumen-backend
sudo journalctl -u lumen-backend -f
pm2 logs lumen-docs-api --lines 100

# Frontend
sudo systemctl status lumen-frontend
sudo journalctl -u lumen-frontend -f

# Etherpad
sudo systemctl status etherpad
sudo journalctl -u etherpad -f

# Nginx
sudo nginx -t && sudo systemctl reload nginx
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# Base de données
mysql -u lumen_docs -p lumen_docs

# MinIO
mc alias set local http://localhost:9000 minioadmin minioadmin
mc ls local/lumen-docs
```

---

## Variables d'Environnement Résumé

### Backend (`back_docs/.env`)

| Variable | Description | Exemple |
|----------|-------------|---------|
| `PORT` | Port backend | `3001` |
| `DB_HOST` | Hôte MySQL | `localhost` |
| `DB_PORT` | Port MySQL | `3306` |
| `DB_USER` | Utilisateur MySQL | `lumen_docs` |
| `DB_PASSWORD` | Mot de passe MySQL | `Passer123/` |
| `DB_NAME` | Base de données | `lumen_docs` |
| `JWT_SECRET` | Secret JWT (changer en prod !) | `...` |
| `ETHERPAD_URL` | Etherpad interne (backend→API) | `http://127.0.0.1:9001` |
| `ETHERPAD_PUBLIC_URL` | Etherpad public (iframe HTTPS) | `https://votre-domaine` |
| `ETHERPAD_APIKEY` | Clé API Etherpad | `...` |
| `MINIO_ENDPOINT` | MinIO host | `localhost` |
| `MINIO_PORT` | MinIO port | `9000` |
| `MINIO_ACCESS_KEY` | MinIO access key | `minioadmin` |
| `MINIO_SECRET_KEY` | MinIO secret key | `minioadmin` |
| `MINIO_BUCKET` | Bucket MinIO | `lumen-docs` |
| `MINIO_USE_SSL` | MinIO SSL | `false` |
| `MINIO_PUBLIC_URL` | MinIO public URL | `http://localhost:9000` |
| `FRONTEND_ORIGIN` | Origine frontend (CORS) | `https://votre-domaine:8080` |

### Frontend (`front_docs/.env`)

| Variable | Description | Exemple |
|----------|-------------|---------|
| `VITE_API_URL` | URL de l'API backend | `https://votre-domaine` |

---

## API Principales

### Authentification

| Méthode | Route | Description |
|---------|-------|-------------|
| `POST` | `/api/auth/register` | Inscription |
| `POST` | `/api/auth/login` | Connexion |
| `GET` | `/api/auth/me` | Profil utilisateur |

### Documents

| Méthode | Route | Permission | Description |
|---------|-------|------------|-------------|
| `GET` | `/api/docs` | — | Liste docs (owner + shared) |
| `POST` | `/api/docs` | — | Créer document |
| `GET` | `/api/docs/:id` | `read` | Détail doc + etherpad_url |
| `PUT` | `/api/docs/:id` | `edit` | Modifier titre/html/starred |
| `DELETE` | `/api/docs/:id` | `delete` | Supprimer (owner) |
| `POST` | `/api/docs/:id/duplicate` | `read` | Dupliquer |
| `PUT` | `/api/docs/:id/visibility` | `share` | Toggle public/privé |
| `GET` | `/api/docs/:id/etherpad-url` | `read` | URL iframe Etherpad |
| `GET` | `/api/docs/:id/permissions` | `share` | Liste permissions |
| `PUT` | `/api/docs/:id/permissions` | `share` | Accorder/modifier |
| `DELETE` | `/api/docs/:id/permissions/:uid` | `share` | Retirer accès |

### Permissions

| Rôle | Lecture | Commentaire | Édition | Partage | Suppression |
|------|---------|-------------|---------|---------|-------------|
| `viewer` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `commenter` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `editor` | ✅ | ✅ | ✅ | ❌* | ❌ |
| `owner` | ✅ | ✅ | ✅ | ✅ | ✅ |

* `editor` avec `can_share=1` peut partager.

---

## Tests

```bash
# Backend
cd back_docs
npm test

# Frontend
cd front_docs
npm run lint
npm run format
```

---

## Dépannage

| Problème | Solution |
|----------|----------|
| `Etherpad non configuré` | Vérifier `ETHERPAD_URL`, `ETHERPAD_APIKEY`, `etherpad-dev` actif |
| `403 Forbidden` sur `/api/*` | JWT expiré/invalide → relogin |
| `404` sur `/p/<padId>` | Pad non créé → recharger page (retry auto 20x) |
| `ERR_CERT_AUTHORITY_INVALID` | Certificat auto-signé → accepter dans navigateur ou configurer Let's Encrypt |
| `ERR_CERT_AUTHORITY_INVALID` sur login | CORS : vérifier `FRONTEND_ORIGIN` dans backend `.env` |
| `404 /p/<padId>` via Nginx | `proxy_cache off` dans `location /p/` |
| `Etherpad ne répond pas` | `systemctl restart etherpad` + `journalctl -u etherpad -f` |

---

## Licence

MIT — Voir `LICENSE` dans chaque composant.