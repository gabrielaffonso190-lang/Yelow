# VANTA

Bot modular para Discord, em Node.js 22.9+ com discord.js v14 e ES Modules.

## Funcionalidades

- `/ping`, `/healty`, `/config center`, `/comprar`, `/carrinho`,
  `/personalizar` e `/conversa limpar`.
- Configuração por servidor, catálogo editável, estoque, carrinhos, cupons,
  pedidos e tickets privados persistidos no SQLite existente.
- Painel MATRIX persistente no canal configurado (por padrão,
  `1560463567025606677`), com indicadores operacionais e recuperação após
  reinicialização. O painel atualiza a mensagem registrada em vez de publicar
  uma nova a cada inicialização.
- `/anuncio preparar` para criar prévias, anexar imagens do Discord, limitar
  menções a um cargo escolhido, adicionar um botão HTTPS e reutilizar até dez
  modelos administrativos.
- Identidade visual VANTA, assinatura `Vanta - 2027` e artes quadradas
  individuais para os 26 produtos padrão. Detalhes de produto anexarão a arte
  correspondente quando disponível; imagens próprias enviadas pela equipe têm
  precedência.
- IA por menção, com histórico limitado, ferramentas explícitas e propostas de
  alteração sujeitas à aprovação da equipe.
- Sessões privadas de personalização com prazo de 15 minutos e armazenamento
  local privado de imagens enviadas no Discord.
- Prefixo `!vinter ping` (legado; o nome deste comando ainda não foi migrado).

Pix pelas APIs documentadas da Z.PAY e da VoxPay está integrado ao fluxo
existente de pedidos. Z.PAY é o provedor principal por padrão e VoxPay é o
alternativo; custos de fornecedor não encontrados permanecem pendentes, e
Robux/GamePass são encaminhados à equipe para confirmação.

## Requisitos

- Node.js 22.9 ou superior (`node:sqlite` e carregamento opcional de `.env`).
- Aplicação/bot configurados no
  [Discord Developer Portal](https://discord.com/developers/applications).
- `DISCORD_TOKEN` e o intent **Message Content Intent** habilitado para a IA por
  menção e o prefixo.
- O arquivo SQLite existente em `data/vintermod.sqlite`. O caminho pode ser
  substituído com `DATABASE_PATH`.
- `NVIDIA_API_KEY` para conversar com o provedor de IA.
- `ZPAY_CLIENT_ID` e `ZPAY_CLIENT_SECRET` para criar cobranças Pix.
- `ZPAY_ENVIRONMENT` pode ser `production` (padrão) ou `sandbox`.
- `VOXPAY_API_KEY` para habilitar VoxPay como provedor alternativo.

## Configuração

Copie `.env.example` para `.env`, configure os valores localmente ou use os
Codespaces Secrets. Não faça commit de `.env`, tokens, imagens ou do banco de
dados. O bot não imprime valores secretos.

```sh
cp .env.example .env
npm install
```

Configure `DISCORD_CLIENT_ID` para registrar comandos. `DISCORD_GUILD_ID` é
opcional e limita o registro ao servidor de desenvolvimento.
`MATRIX_CHANNEL_ID` pode substituir o canal padrão do painel MATRIX. Convide o
bot com os escopos `bot` e `applications.commands`, além das permissões
necessárias para criar canais privados, gerenciar canais e enviar mensagens.

## Execução

```sh
npm test
npm run deploy:commands
npm start
```

`npm run deploy:commands` publica os comandos para o Discord; execute apenas
quando quiser atualizar o registro. `npm run dev` inicia o modo watch.

No primeiro `/comprar` ou `/config center`, o catálogo inicial é inserido
somente para produtos que ainda não existem no servidor. Os estoques definidos
no prompt são usados para os sete itens com quantidades conhecidas; os demais
começam em 5, sem serem redefinidos em reinicializações. Custos não fornecidos
não são inventados. A equipe deve configurar o custo do fornecedor no Config
Center; o preço de venda é calculado como custo × 1,30.

## Config Center e segurança

Use `/config center` como proprietário, administrador do servidor ou portador
dos cargos Poder geral/Founder configurados no código. Gestão e Direção podem
consultar as seções operacionais do MATRIX e atender tickets, mas não alterar a
configuração administrativa. As ações interativas também validam permissão no
servidor.

O comando `/healty` exibe latência, uptime, memória, CPU e estado do SQLite e
das integrações sem revelar credenciais. O estado da IA não é uma verificação
ao vivo do provedor. Relatórios financeiros, histórico `/minhas-compras`,
feedback e missões ainda não estão implementados. O MATRIX identifica recursos
indisponíveis. O gerenciador de anúncios está disponível por `/anuncio preparar`.

O MATRIX mostra contagens diretamente das tabelas atuais. O schema de pedidos
rastreia tentativas de cobrança em uma tabela aditiva `payments`; o estado do
pedido existente não foi alterado. Não existe comando de limpeza em massa no
projeto.

Z.PAY usa o SDK oficial documentado `@isnouu/zpay-sdk` (Node.js 18+); VoxPay
usa `POST /api/v1/charges` e `GET /api/v1/charges/{id}` documentados em
[voxpaybr.com/documentacao](https://voxpaybr.com/documentacao). Valores de
entrada são reais; os snapshots financeiros são centavos. Z.PAY limita Pix
entre R$ 2,00 e R$ 2.000,00, e VoxPay aplica os limites da própria API. Os
provedores usam, respectivamente, `idempotencyKey` e `external_reference`
estáveis por pedido. O QR, copia e cola, valor e status são exibidos no ticket.
HTTP 401/403 e erros VoxPay documentados de autenticação/configuração são
recusas definitivas e ativam o próximo provedor configurado. Timeout, 429 e
erros com resultado incerto nunca iniciam failover ou uma segunda cobrança.

Para webhooks, configure `ZPAY_WEBHOOK_SECRET` e/ou `VOXPAY_WEBHOOK_SECRET` e
aponte o dashboard para `https://seu-dominio/webhooks/zpay` ou
`https://seu-dominio/webhooks/voxpay`, encaminhando ao
`ZPAY_WEBHOOK_PORT` (padrão 8787). O servidor valida assinatura HMAC, timestamp,
valor do pedido e idempotência; eventos Z.PAY Sandbox são recusados. A
documentação VoxPay informa que o envio externo está pausado; para essa
integração, a confirmação normal usa consulta autenticada ao status. Ambos os
endpoints precisam ser publicados via HTTPS.

`PAYMENT_PROVIDER` seleciona a ordem de tentativa (`zpay` por padrão,
`voxpay` para priorizar VoxPay). Nenhuma cobrança real foi criada durante os
testes.

O Sandbox Z.PAY é opt-in por `ZPAY_ENVIRONMENT=sandbox`, usa a base
`/api/v1/sandbox`, fica isolado das cobranças de produção e não tenta VoxPay
como fallback. A arte do pedido é marcada como teste; simulações são limitadas
ao adaptador de teste e nunca marcam pagamentos de produção. Webhooks Sandbox
são recusados no endpoint de produção.

Anúncios são preparados e confirmados por administradores. Uma publicação tem
registro idempotente: se o resultado de uma tentativa ficar incerto, o bot
bloqueia uma segunda publicação do mesmo rascunho e pede verificação manual no
canal antes de preparar outro.

O provedor de IA usa o endpoint OpenAI-compatible da NVIDIA e o modelo
`z-ai/glm-5.3`, sujeito à disponibilidade da conta. Erros HTTP, limites e
timeouts são tratados sem registrar a chave. O modelo Flash não é oferecido
sem confirmação de acesso.

As artes do catálogo podem ser regeneradas com `npm run build:product-art`.
Elas são composições gráficas próprias, sem logotipos oficiais de terceiros.
Emojis da aplicação são opcionais: configure os nomes reais usando
`VANTA_EMOJI_*` depois que o bot puder consultar a aplicação. O código não
presume IDs, e os componentes não recebem emoji quando um nome configurado não
existe.

Uploads são aceitos apenas dentro de sessões de personalização. O conteúdo é
validado por assinatura binária, limitado a 8 MB e armazenado em
`data/private-images` com permissões privadas. Imagens só são anexadas a painéis
quando um membro autorizado as seleciona e publica.

## Limitações externas

- As credenciais Z.PAY/VoxPay ainda precisam ser configuradas e não houve
  validação com uma cobrança real. A tentativa de consulta VoxPay anterior
  retornou `401 invalid_api_key`, portanto confira/revogue a chave no painel.
- O bot não automatiza a entrega dos produtos. Confirmação de pagamento fica
  registrada, mas a equipe continua responsável pelo atendimento/entrega.
- O bot não expõe comandos Discord para simular pagamentos Sandbox; a API de
  simulação fica disponível apenas no adaptador Z.PAY em modo Sandbox.
- O login do bot também foi recusado como `TokenInvalid` na última tentativa.
  Confira o Secret `DISCORD_TOKEN` no ambiente e reinicie o Codespace; não
  compartilhe seu valor.
- É preciso configurar custos reais dos produtos antes de disponibilizá-los
  para compra. Robux e GamePass aguardam confirmação manual de preço.
- A configuração da IA não comprova disponibilidade da chave, do endpoint ou
  do modelo na conta; valide no ambiente antes de anunciar a função como ativa.
- O SQLite local exige armazenamento persistente no ambiente de execução. Os
  uploads também dependem da persistência de `data/private-images`.
