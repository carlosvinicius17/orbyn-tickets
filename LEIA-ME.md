# Orbyn Tickets v1.6.0 — Guia de instalação

Tempo estimado: 15 a 20 minutos.

## O que você precisa

- Um servidor Discord onde você seja administrador
- Uma conta no Discord com acesso ao [Discord Developer Portal](https://discord.com/developers/applications)
- Uma hospedagem com **Node.js 20 ou mais novo** (por exemplo, Discloud com 512 MB de RAM, ou uma VPS)

## 1. Criar o seu bot

1. No Developer Portal, clique em **New Application** e dê um nome.
2. Em **General Information**, copie o **Application ID**. Ele será o seu `CLIENT_ID`.
3. Abra a aba **Bot**:
   - Clique em **Reset Token** e copie o token. Ele será o seu `DISCORD_TOKEN`.
   - Em **Privileged Gateway Intents**, ligue **Message Content Intent** e salve.
4. Abra **OAuth2 → URL Generator**:
   - Em *Scopes*, marque `bot` e `applications.commands`.
   - Em *Bot Permissions*, marque **Administrator** (é o jeito mais simples).
5. Abra o link gerado e adicione o bot ao seu servidor.

> **Importante:** nunca envie o token a ninguém nem publique em lugar nenhum. Quem tem o token controla o seu bot. Se ele vazar, volte ao Developer Portal e clique em **Reset Token**. O suporte nunca pede o seu token.

## 2. Configurar o arquivo `.env`

1. Renomeie `.env.example` para `.env`.
2. Preencha:
   - `DISCORD_TOKEN`: o token do passo 1
   - `CLIENT_ID`: o Application ID do passo 1
   - `GUILD_ID`: o ID do seu servidor. No Discord, ative *Configurações → Avançado → Modo desenvolvedor*, clique com o botão direito no servidor e escolha **Copiar ID do servidor**.
3. Ajuste, se quiser:

| Variável | O que faz |
|---|---|
| `SERVER_NAME` / `BOT_NAME` | Nome do servidor e do bot nas mensagens e no transcript |
| `BOT_ROLE_NAME` | Nome do cargo do bot no servidor |
| `BRAND_COLOR` | Cor dos painéis (ex.: `#5865F2`) |
| `TICKET_MODEL` | Tipo de atendimento: `store`, `community`, `roleplay` ou `corporation` |
| `MAX_OPEN_TICKETS` | Total de tickets abertos ao mesmo tempo |
| `MAX_OPEN_TICKETS_PER_USER` | Tickets abertos por pessoa |
| `TICKET_INACTIVITY_WARNING_HOURS` | Horas sem resposta do cliente até o aviso (0 desliga) |
| `TICKET_INACTIVITY_CLOSE_HOURS` | Horas após o aviso até fechar sozinho (0 desliga) |
| `TICKET_STAFF_REMINDER_HOURS` | Horas até lembrar a equipe de um ticket sem resposta (0 desliga) |
| `SEND_TRANSCRIPT_TO_USER` | Envia o transcript no privado do cliente (`true` ou `false`) |

**Imagem do painel:** para usar a sua imagem no painel de tickets, substitua o arquivo `assets/banner-orbyn-tickets-v1.jpg` pela sua, mantendo o mesmo nome.

## 3. Hospedar o bot

**Discloud:** envie a pasta do bot como `.zip` (com o `.env` já preenchido). O arquivo `discloud.config` já vem pronto.

**VPS ou PC:** dentro da pasta do bot, rode:

```
npm install
npm start
```

Para manter ligado 24 horas, use o `pm2` (`pm2 start src/index.js --name tickets`).

## 4. Primeiros comandos no Discord

Com o bot online, use estes comandos (só administradores veem):

1. `/instalar-tickets` — cria a categoria de atendimento, o fórum de registros, o painel e os cargos.
2. `/configurar-tickets` — ajusta nome, cor e opções pela tela de configuração.
3. `/painel-tickets` — publica ou atualiza o painel onde os clientes abrem tickets.
4. `/autorizar-cargo` e `/cargos-tickets` — escolhem e listam os cargos que atendem.
5. `/manutencao-tickets` — pausa a abertura de novos tickets quando precisar.

Dentro de um ticket, a equipe pode assumir, gerenciar participantes, renomear e fechar usando os botões. Ao fechar, o bot gera o transcript, registra no fórum e pede a avaliação ao cliente. Tickets parados recebem aviso e são fechados sozinhos, conforme o `.env`.

## 5. Backup e atualização

- O bot guarda os dados dos tickets abertos em `data/tickets.json`. Antes de atualizar ou trocar de hospedagem, copie a pasta `data/`.
- Feche os tickets abertos antes de substituir os arquivos.

## 6. Problemas comuns

| Problema | O que fazer |
|---|---|
| Os comandos não aparecem | Confira `CLIENT_ID` e `GUILD_ID` e se o bot foi adicionado com o escopo `applications.commands`. Reinicie o bot. |
| Erro `Used disallowed intents` | Ligue **Message Content Intent** na aba Bot do Developer Portal. |
| O bot não fica online | Confira o `DISCORD_TOKEN` (sem espaços) e os logs da hospedagem. |
| Não consigo criar canais ou cargos | Dê ao bot a permissão **Administrator** e deixe o cargo dele acima dos cargos que ele gerencia. |
| O painel não atualiza | Rode `/painel-tickets` de novo. Se continuar, apague a mensagem antiga do painel e rode o comando outra vez. |

## Suporte

Fale com a Orbyn Store pelo chat do pedido ou por um ticket, informando o que aparece nos logs. Nunca envie o seu token.
