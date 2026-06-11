# Baileys API

<a href="https://fazer.ai?utm_source=github&utm_medium=en&utm_campaign=baileys-api"><img alt="fazer.ai logo" src="https://framerusercontent.com/images/HqY9djLTzyutSKnuLLqBr92KbM.png?scale-down-to=256" height="75"/></a>

<a href="https://github.com/WhiskeySockets/Baileys"><img alt="Baileys logo" src="https://raw.githubusercontent.com/WhiskeySockets/Baileys/refs/heads/master/Media/logo.png" height="75"/></a>

This project provides an API interface for interacting with WhatsApp using the [Baileys library](https://github.com/WhiskeySockets/Baileys).

> [!NOTE]
> 🇧🇷 Esse README também está disponível em português: [README-pt.md](README-pt.md)

## Stack

- **Runtime**: [Bun](https://bun.sh/)
- **HTTP Framework**: [Elysia.js](https://elysiajs.com/)
- **Database**: [Redis](https://redis.io/) (for session storage and API key management)
- **WhatsApp Integration**: [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)

> [!NOTE]
> This project is not meant to be a full-fledged WhatsApp server. It is a wrapper around the Baileys library, providing an HTTP interface for easier integration with other applications.
>
> Thus, we do not store WhatsApp messages or any other data (aside from credentials for auto-reconnecting).
>
> If you need a chat application with a database, consider using our fork of [Chatwoot](https://github.com/fazer-ai/chatwoot/), which integrates with this API.

## Functionality

The API exposes the following endpoints. Keep in mind this project is in early development, and many features are still being implemented.

> [!NOTE]
> See also our [Swagger documentation](https://fazer-ai.github.io/baileys-api/) for a more detailed overview of the API.

### Status

- `GET /status`: Checks if the server is running. Returns "OK" if the server is healthy.
- `GET /status/auth`: Checks if the provided API key is valid. Returns "OK" if authenticated.

### Connections

- `POST /connections/:phoneNumber`: Initiates a new WhatsApp connection for the given phone number.
- `PATCH /connections/:phoneNumber/presence`: Updates the presence status for a connection.
- `POST /connections/:phoneNumber/send-message`: Sends a message through an active connection.
- `POST /connections/:phoneNumber/read-messages`: Marks messages as read.
- `DELETE /connections/:phoneNumber`: Logs out and disconnects a WhatsApp connection.

> [!IMPORTANT]
> The `phoneNumber` parameter in the URL should be in the format `+<country_code><phone_number>`, e.g. `+551234567890`.

### Admin

- `POST /admin/connections/logout-all`: Logs out all active WhatsApp connections. (Requires admin role API key)

## Deployment

This project includes a [`docker-compose.coolify.yml`](./docker-compose.coolify.yml) file ready for deployment on [Coolify](https://coolify.io/).

### Coolify Deployment

The provided Docker Compose file is configured to work within a Coolify environment that has an existing Redis instance on the same network. The API will connect to this Redis instance using the `REDIS_URL` and `REDIS_PASSWORD` environment variables that you should provide in the environment variables section of the Coolify dashboard.

The compose file also automates the creation of a default API key. This key is generated using `SERVICE_PASSWORD_64_DEFAULTAPIKEY` (an auto-generated Coolify service password) and can be retrieved from the service's environment variables in the Coolify dashboard.

### Other Docker Environments

The `docker-compose.coolify.yml` can be adapted for other Docker environments. You may need to:

1.  **Provide a Redis Instance**:
    - If you have an existing Redis instance, update the `REDIS_URL` and `REDIS_PASSWORD` environment variables in the `docker-compose.yml` file to point to your Redis service.
    - Alternatively, you can add a new Redis service definition to the `docker-compose.yml` file.
2.  **API Key Management**:
    - In production/non-development environments, authentication is required. The `manage-api-keys.ts` script is used to create and manage API keys.
    - The provided `docker-compose.coolify.yml` automatically creates a user API key using the command: `bun manage-api-keys create user ${SERVICE_PASSWORD_64_DEFAULTAPIKEY}`. You can adapt this or run the script manually within the container or a separate environment to generate your API keys.
    - To create an API key manually:
      ```bash
      bun scripts/manage-api-keys.ts create <role> [key]
      ```
      (e.g., `bun scripts/manage-api-keys.ts create user mysecretapikey`)
    - Store these keys securely and provide them in the `x-api-key` header for authenticated requests.
    - In development (`NODE_ENV=development`), authentication is bypassed.

### Scaling Horizontally (Multiple Instances)

Running more than one instance against the same Redis is supported through a proxy + workers topology. Each WhatsApp identity is owned via a Redis **lease** (renewed periodically, self-fencing on loss), so two instances never fight over the same phone number with `conflict/replaced` loops.

Roles, selected via the `ROLE` env var:

- `standalone` (default) — single instance serving HTTP directly, exactly like before. It also participates in the lease protocol, which gives rolling deploys a graceful handoff for free: on SIGTERM the old container closes its sockets and releases its leases before the new one claims them — no churn window.
- `worker` — holds the WhatsApp sockets, never exposed to clients. Claims unleased phones up to its fair share of the cluster, renews leases, sheds load gradually when over-share (rebalance), and hands everything off on SIGTERM.
- `proxy` — the single client-facing entry point. Stateless: resolves which worker owns each phone via Redis and forwards requests (including `GET /media/:messageId`, routed to the instance holding the file). Point your client (e.g. chatwoot's `BAILEYS_PROVIDER_DEFAULT_URL`) at the proxy.

See [`docker-compose.cluster.yml`](./docker-compose.cluster.yml) for a complete example (1 proxy + 2 workers + Redis with AOF).

Behavior under the common scenarios:

- **A worker crashes** — its leases expire within `CLUSTER_LEASE_TTL_MS` (default 30s); survivors claim the orphaned phones with limited reconnect concurrency and jitter, so a 50-connection failover proceeds in waves instead of a storm.
- **A new worker joins** — it steals nothing at boot (everything is leased). Overloaded workers detect they are above the cluster fair share and migrate one connection at a time (rate-limited, with a directed handoff so the migration lands on the underloaded worker and never ping-pongs). A 100-connection 1→2 migration equalizes gradually (~8 minutes at default intervals), each phone seeing a single brief reconnect.
- **Rolling deploy** — bring the new container up before stopping the old one; the new worker waits (leases arbitrate), and the old worker's SIGTERM handoff transfers connections in seconds with zero `conflict/replaced` events. Make sure the orchestrator's stop grace period exceeds `CLUSTER_SHUTDOWN_TIMEOUT_MS`.
- **Redis goes down** — workers keep their sockets (messages keep flowing) and pause claims; on recovery each worker re-asserts the leases it already holds, with no reconnects.

Operational requirements:

- Redis must persist with **AOF** (`appendonly yes`): the Signal auth state lives there, and restoring a stale snapshot regresses the crypto ratchet, forcing re-pairing.
- Workers must be reachable from the proxy on the shared network (`WORKER_BASE_URL`, defaults to the container hostname).
- Pending-QR pairings are tied to the instance showing the QR code; they are excluded from failover/rebalance and restart via a new `POST /connections` if that instance dies.
- One caveat on the **first** deploy of a lease-aware version over a non-lease version: the old container does not participate in the protocol, so that one rollout still shows the legacy reconnect churn. Subsequent deploys are clean.

## Development Setup

1.  **Clone the repository.**
2.  **Install dependencies**:
    ```bash
    bun install
    ```
3.  **Set up environment variables**:
    Copy the example environment file:

    ```bash
    cp .env.example .env
    ```

    Then, edit the `.env` file with your desired configurations.

| Variable                              | Description                                                                                                | Default                  |
|---------------------------------------|------------------------------------------------------------------------------------------------------------|--------------------------|
| `NODE_ENV`                            | Set to `development` for local development or `production` for deployment.                                 | `development`            |
| `PORT`                                | The port the API server will listen on.                                                                    | `3025`                   |
| `LOG_LEVEL`                           | The general log level for the application.                                                                 | `info`                   |
| `BAILEYS_LOG_LEVEL`                   | Specific log level for the Baileys library.                                                                | `warn`                   |
| `BAILEYS_CLIENT_VERSION`              | The Baileys client version to use. Only change if you know what you're doing!                              | `default`                |
| `REDIS_URL`                           | The connection URL for your Redis instance.                                                                | `redis://localhost:6379` |
| `REDIS_PASSWORD`                      | The password for your Redis instance (if any).                                                             |                          |
| `WEBHOOK_RETRY_POLICY_MAX_RETRIES`    | Maximum number of retries for sending webhook events.                                                      | `3`                      |
| `WEBHOOK_RETRY_POLICY_RETRY_INTERVAL` | Initial interval in milliseconds between webhook retry attempts.                                           | `5000`                   |
| `WEBHOOK_RETRY_POLICY_BACKOFF_FACTOR` | Factor by which the retry interval increases after each attempt (exponential backoff).                     | `3`                      |
| `CORS_ORIGIN`                         | The allowed origin for CORS requests. Should be set if you plan to run the API on a dedicated server.      | `localhost:3025`         |
| `IGNORE_GROUP_MESSAGES`               | If `true`, messages from groups will be ignored.                                                           | `false`                  |
| `IGNORE_STATUS_MESSAGES`              | If `true`, status updates will be ignored.                                                                 | `true`                   |
| `IGNORE_BROADCAST_MESSAGES`           | If `true`, messages from broadcast lists will be ignored.                                                  | `true`                   |
| `IGNORE_NEWSLETTER_MESSAGES`          | If `true`, messages from newsletters/channels will be ignored.                                             | `true`                   |
| `IGNORE_BOT_MESSAGES`                 | If `true`, messages from bots (e.g., official WhatsApp bot) will be ignored.                               | `true`                   |
| `IGNORE_META_AI_MESSAGES`             | If `true`, messages from Meta AI will be ignored.                                                          | `true`                   |

4.  **(Optional) Create API Keys for Development (if not bypassing auth)**:
    If you wish to test authentication in development, you can create API keys:

    ```bash
    bun scripts/manage-api-keys.ts create user yourdesiredapikey
    ```

    Remember to set `NODE_ENV` to something other than `development` in your `.env` if you want to enforce API key usage locally.

5.  **Start the development server**:

    ```bash
    bun dev
    ```

    The server will watch for file changes and automatically restart.

6.  **API Documentation**:
    Open [http://localhost:3025/swagger](http://localhost:3025/swagger) in your browser to view the Swagger API documentation and test the endpoints.


## Roadmap (Work in Progress)

- [ ] Add support for more Baileys features
- [ ] Add unit testing
