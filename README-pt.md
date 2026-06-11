# Baileys API

<a href="https://fazer.ai?utm_source=github&utm_medium=pt&utm_campaign=baileys-api"><img alt="fazer.ai logo" src="https://framerusercontent.com/images/HqY9djLTzyutSKnuLLqBr92KbM.png?scale-down-to=256" height="75"/></a>

<a href="https://github.com/WhiskeySockets/Baileys"><img alt="Baileys logo" src="https://raw.githubusercontent.com/WhiskeySockets/Baileys/refs/heads/master/Media/logo.png" height="75"/></a>

Este projeto fornece uma interface API para interagir com o WhatsApp usando a biblioteca [Baileys](https://github.com/WhiskeySockets/Baileys).

> [!NOTE]
> 🇺🇸 This README is also available in English: [README.md](README.md)

## Stack

- **Runtime**: [Bun](https://bun.sh/)
- **Framework HTTP**: [Elysia.js](https://elysiajs.com/)
- **Banco de Dados**: [Redis](https://redis.io/) (para armazenamento de sessão e gerenciamento de chaves de API)
- **Integração com WhatsApp**: [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)

> [!NOTE]
> Este projeto não se destina a ser um servidor WhatsApp completo. É um wrapper em torno da biblioteca Baileys, fornecendo uma interface HTTP para facilitar a integração com outras aplicações.
>
> Assim, não armazenamos mensagens do WhatsApp ou quaisquer outros dados (além das credenciais para reconexão automática).
>
> Se você precisa de uma aplicação de chat com banco de dados, considere usar nosso fork do [Chatwoot](https://github.com/fazer-ai/chatwoot/), que se integra com esta API.

## Funcionalidades

A API expõe os seguintes endpoints. Tenha em mente que este projeto está em desenvolvimento inicial e muitas funcionalidades ainda estão sendo implementadas.

> [!NOTE]
> Veja também nossa [documentação Swagger](https://fazer-ai.github.io/baileys-api/) para uma visão mais detalhada da API.

### Status

- `GET /status`: Verifica se o servidor está em execução. Retorna "OK" se o servidor estiver funcionando corretamente.
- `GET /status/auth`: Verifica se a chave de API fornecida é válida. Retorna "OK" se autenticado.

### Conexões

- `POST /connections/:phoneNumber`: Inicia uma nova conexão WhatsApp para o número de telefone fornecido.
- `PATCH /connections/:phoneNumber/presence`: Atualiza o status de presença para uma conexão.
- `POST /connections/:phoneNumber/send-message`: Envia uma mensagem através de uma conexão ativa.
- `POST /connections/:phoneNumber/read-messages`: Marca mensagens como lidas.
- `DELETE /connections/:phoneNumber`: Faz logout e desconecta uma conexão WhatsApp.

> [!IMPORTANT]
> O parâmetro `phoneNumber` na URL deve estar no formato `+<codigo_do_pais><telefone>`, ex: `+551234567890`.

### Admin

- `POST /admin/connections/logout-all`: Faz logout de todas as conexões WhatsApp ativas. (Requer chave de API com função de administrador)

## Deployment

Este projeto inclui um arquivo [`docker-compose.coolify.yml`](./docker-compose.coolify.yml) pronto para deployment no [Coolify](https://coolify.io/).

### Deployment com Coolify

O arquivo Docker Compose fornecido está configurado para funcionar dentro de um ambiente Coolify que possui uma instância Redis existente na mesma rede. A API se conectará a esta instância Redis usando as variáveis de ambiente `REDIS_URL` e `REDIS_PASSWORD` que você deve fornecer na seção de variáveis de ambiente do painel do Coolify.

O arquivo compose também automatiza a criação de uma chave de API padrão. Esta chave é gerada usando `SERVICE_PASSWORD_64_DEFAULTAPIKEY` (uma senha de serviço Coolify gerada automaticamente) e pode ser recuperada das variáveis de ambiente do serviço no painel do Coolify.

### Outros Ambientes Docker

O `docker-compose.coolify.yml` pode ser adaptado para outros ambientes Docker. Você pode precisar:

1.  **Fornecer uma Instância Redis**:
    - Se você tiver uma instância Redis existente, atualize as variáveis de ambiente `REDIS_URL` e `REDIS_PASSWORD` no arquivo `docker-compose.yml` para apontar para o seu serviço Redis.
    - Alternativamente, você pode adicionar uma nova definição de serviço Redis ao arquivo `docker-compose.yml`.
2.  **Gerenciamento de Chaves de API**:
    - Em ambientes de produção/não desenvolvimento, a autenticação é necessária. O script `manage-api-keys.ts` é usado para criar e gerenciar chaves de API.
    - O `docker-compose.coolify.yml` fornecido cria automaticamente uma chave de API de usuário usando o comando: `bun manage-api-keys create user ${SERVICE_PASSWORD_64_DEFAULTAPIKEY}`. Você pode adaptar isso ou executar o script manualmente dentro do contêiner ou em um ambiente separado para gerar suas chaves de API.
    - Para criar uma chave de API manualmente:
      ```bash
      bun scripts/manage-api-keys.ts create <role> [key]
      ```
      (ex: `bun scripts/manage-api-keys.ts create user minhachavesecreta`)
    - Armazene essas chaves com segurança e forneça-as no cabeçalho `x-api-key` para solicitações autenticadas.
    - Em desenvolvimento (`NODE_ENV=development`), a autenticação é ignorada.

### Escalando Horizontalmente (Múltiplas Instâncias)

Rodar mais de uma instância no mesmo Redis é suportado por meio de uma topologia proxy + workers. Cada identidade do WhatsApp é possuída via um **lease** no Redis (renovado periodicamente, com self-fencing em caso de perda), então duas instâncias nunca disputam o mesmo número com loops de `conflict/replaced`.

Roles, selecionadas pela variável de ambiente `ROLE`:

- `standalone` (padrão) — instância única servindo HTTP diretamente, exatamente como antes. Também participa do protocolo de lease, o que dá aos rolling deploys um handoff gracioso de graça: no SIGTERM, o container antigo fecha seus sockets e libera seus leases antes que o novo os reivindique — sem janela de churn.
- `worker` — segura os sockets do WhatsApp, nunca exposto a clientes. Reivindica números sem lease até sua fração justa do cluster, renova leases, transfere carga gradualmente quando acima da fração (rebalance) e entrega tudo no SIGTERM.
- `proxy` — o único ponto de entrada voltado ao cliente. Stateless: resolve qual worker possui cada número via Redis e encaminha as requisições (incluindo `GET /media/:messageId`, roteado para a instância que tem o arquivo). Aponte seu cliente (ex.: `BAILEYS_PROVIDER_DEFAULT_URL` do chatwoot) para o proxy.

Veja [`docker-compose.cluster.yml`](./docker-compose.cluster.yml) para um exemplo completo (1 proxy + 2 workers + Redis com AOF).

Comportamento nos cenários comuns:

- **Um worker cai** — seus leases expiram dentro de `CLUSTER_LEASE_TTL_MS` (padrão 30s); os sobreviventes reivindicam os números órfãos com concorrência de reconexão limitada e jitter, então um failover de 50 conexões procede em ondas em vez de uma tempestade.
- **Um worker novo entra** — não rouba nada no boot (tudo está com lease). Workers sobrecarregados detectam que estão acima da fração justa do cluster e migram uma conexão por vez (com rate limit e handoff direcionado, para que a migração caia no worker subutilizado e nunca faça ping-pong). As vítimas são escolhidas priorizando conexões idle: sem tráfego de mensagens dentro de `CLUSTER_REBALANCE_IDLE_THRESHOLD_MS` (padrão 5 min) e sem webhooks in-flight migram de forma invisível; se tudo estiver no meio de conversa, a migração é adiada para o próximo intervalo, a menos que o desbalanceio exceda 2x a fração justa, caso em que a conexão menos ativa é movida mesmo assim. Uma migração 1→2 de 100 conexões equaliza gradualmente (~8 minutos nos intervalos padrão), cada número vendo uma única reconexão breve.
- **Rolling deploy** — suba o container novo antes de parar o antigo; o worker novo espera (os leases arbitram), e o handoff do SIGTERM do antigo transfere as conexões em segundos com zero eventos de `conflict/replaced`. Garanta que o stop grace period do orquestrador exceda `CLUSTER_SHUTDOWN_TIMEOUT_MS`.
- **Redis cai** — os workers mantêm seus sockets (mensagens continuam fluindo) e pausam reivindicações; na recuperação, cada worker reafirma os leases que já possui, sem reconexões.

Requisitos operacionais:

- O Redis deve persistir com **AOF** (`appendonly yes`): o estado de auth do Signal vive lá, e restaurar um snapshot antigo regride o ratchet criptográfico, forçando novo pareamento.
- Os workers devem ser alcançáveis pelo proxy na rede compartilhada (`WORKER_BASE_URL`, padrão é o hostname do container).
- Pareamentos com QR pendente ficam presos à instância exibindo o QR code; são excluídos de failover/rebalance e reiniciam via um novo `POST /connections` se aquela instância morrer.
- Uma ressalva no **primeiro** deploy de uma versão com lease sobre uma versão sem lease: o container antigo não participa do protocolo, então aquele rollout ainda exibe o churn de reconexão legado. Deploys subsequentes são limpos.

#### Workers em múltiplos hosts

O [`docker-compose.cluster.yml`](./docker-compose.cluster.yml) roda todos os serviços em um único host, onde o proxy alcança cada worker pelo hostname da rede Docker (o padrão `WORKER_BASE_URL=http://<hostname>:<porta>`). Para distribuir workers em hosts separados (ou VMs/regiões), três condições precisam valer:

- **Cada worker anuncia um endereço alcançável.** Defina `WORKER_BASE_URL` explicitamente em cada worker para um endereço que o proxy consiga alcançar a partir do host dele, por exemplo `WORKER_BASE_URL=http://10.0.0.21:3025` (IP privado ou nome DNS interno). O valor padrão (hostname do container) só resolve dentro de uma rede Docker compartilhada e não funciona entre hosts.
- **Todos os hosts compartilham um único Redis.** Workers e proxy se coordenam exclusivamente pelo Redis (leases, registry, invalidação de rota), então todo nó aponta `REDIS_URL` para a mesma instância. Mantenha-o próximo aos workers: as leituras/escritas do estado de auth do Signal ficam no hot path.
- **A rede entre os nós é privada.** O tráfego entre nós carrega o estado de auth do Signal e os payloads de mensagens encaminhados. Rode sobre rede privada, VPN (por exemplo WireGuard/Tailscale) ou VPC, e exponha **apenas o proxy** aos clientes. As portas HTTP dos workers e o Redis nunca podem ser publicamente acessíveis: defina `REDIS_PASSWORD` e restrinja essas portas por firewall aos próprios hosts do cluster.

Exemplo: um proxy no host A (`WORKER_BASE_URL` não usado), workers nos hosts B e C cada um com `ROLE=worker`, um `INSTANCE_ID` distinto, `WORKER_BASE_URL` apontando para seu IP privado, e os três compartilhando `REDIS_URL`/`REDIS_PASSWORD`. O proxy resolve a posse pelo Redis e encaminha para o worker que detém o telefone, independente do host.

## Configuração de Desenvolvimento

1.  **Clone o repositório.**
2.  **Instale as dependências**:
    ```bash
    bun install
    ```
3.  **Configure as variáveis de ambiente**:
    Copie o arquivo de exemplo de ambiente:

    ```bash
    cp .env.example .env
    ```

    Em seguida, edite o arquivo `.env` com as configurações desejadas.

| Variável                              | Descrição                                                                                                               | Padrão                   |
|---------------------------------------|-------------------------------------------------------------------------------------------------------------------------|--------------------------|
| `NODE_ENV`                            | Defina como `development` para desenvolvimento local ou `production` para deployment.                                   | `development`            |
| `PORT`                                | A porta em que o servidor da API escutará.                                                                              | `3025`                   |
| `LOG_LEVEL`                           | O nível geral de log para a aplicação.                                                                                  | `info`                   |
| `BAILEYS_LOG_LEVEL`                   | Nível de log específico para a biblioteca Baileys.                                                                      | `warn`                   |
| `BAILEYS_CLIENT_VERSION`              | A versão do cliente Baileys a ser utilizada. Só altere se você souber o que está fazendo!                               | `default`                |
| `REDIS_URL`                           | A URL de conexão para sua instância Redis.                                                                              | `redis://localhost:6379` |
| `REDIS_PASSWORD`                      | A senha para sua instância Redis (se houver).                                                                           |                          |
| `WEBHOOK_RETRY_POLICY_MAX_RETRIES`    | Número máximo de tentativas para enviar eventos de webhook.                                                             | `3`                      |
| `WEBHOOK_RETRY_POLICY_RETRY_INTERVAL` | Intervalo inicial em milissegundos entre tentativas de webhook.                                                         | `5000`                   |
| `WEBHOOK_RETRY_POLICY_BACKOFF_FACTOR` | Fator pelo qual o intervalo de repetição aumenta após cada tentativa (backoff exponencial).                             | `3`                      |
| `CORS_ORIGIN`                         | A origem permitida para solicitações CORS. Deve ser configurado se você planeja executar a API em um servidor dedicado. | `localhost:3025`         |
| `IGNORE_GROUP_MESSAGES`               | Se `true`, mensagens de grupos serão ignoradas.                                                            | `false`                  |
| `IGNORE_STATUS_MESSAGES`              | Se `true`, atualizações de status serão ignoradas.                                                         | `true`                   |
| `IGNORE_BROADCAST_MESSAGES`           | Se `true`, mensagens de listas de transmissão serão ignoradas.                                             | `true`                   |
| `IGNORE_NEWSLETTER_MESSAGES`          | Se `true`, mensagens de newsletters/canais serão ignoradas.                                                | `true`                   |
| `IGNORE_BOT_MESSAGES`                 | Se `true`, mensagens de bots (ex: bot oficial do WhatsApp) serão ignoradas.                                | `true`                   |
| `IGNORE_META_AI_MESSAGES`             | Se `true`, mensagens do Meta AI serão ignoradas.                                                           | `true`                   |

4.  **(Opcional) Crie Chaves de API para Desenvolvimento (se não estiver ignorando a autenticação)**:
    Se desejar testar a autenticação em desenvolvimento, você pode criar chaves de API:

    ```bash
    bun scripts/manage-api-keys.ts create user suachavedapi
    ```

    Lembre-se de definir `NODE_ENV` para algo diferente de `development` em seu `.env` se quiser impor o uso de chave de API localmente.

5.  **Inicie o servidor de desenvolvimento**:

    ```bash
    bun dev
    ```

    O servidor observará as alterações nos arquivos e reiniciará automaticamente.

6.  **Documentação da API**:
    Abra [http://localhost:3025/swagger](http://localhost:3025/swagger) em seu navegador para visualizar a documentação da API Swagger e testar os endpoints.


## Roadmap (Trabalho em Progresso)

- [ ] Adicionar suporte para mais funcionalidades do Baileys
- [ ] Adicionar testes unitários
