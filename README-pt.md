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
| `BAILEYS_PRINT_QR`                    | Se `true`, imprime o código QR de conexão do WhatsApp no terminal.                                                      | `false`                  |
| `REDIS_URL`                           | A URL de conexão para sua instância Redis.                                                                              | `redis://localhost:6379` |
| `REDIS_PASSWORD`                      | A senha para sua instância Redis (se houver).                                                                           |                          |
| `WEBHOOK_RETRY_POLICY_MAX_RETRIES`    | Número máximo de tentativas para enviar eventos de webhook.                                                             | `3`                      |
| `WEBHOOK_RETRY_POLICY_RETRY_INTERVAL` | Intervalo inicial em milissegundos entre tentativas de webhook.                                                         | `5000`                   |
| `WEBHOOK_RETRY_POLICY_BACKOFF_FACTOR` | Fator pelo qual o intervalo de repetição aumenta após cada tentativa (backoff exponencial).                             | `3`                      |
| `CORS_ORIGIN`                         | A origem permitida para solicitações CORS. Deve ser configurado se você planeja executar a API em um servidor dedicado. | `localhost:3025`         |

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
