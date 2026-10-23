# Announcement drafts

Three texts in Portuguese, for review before anyone posts them. Every number comes from a test record in [`first-run.md`](first-run.md) or from the timed run in [`try-it.md`](try-it.md); the records each text uses are listed right below it.

## (a) Mensagem para quem recebeu o repositório

> Oi! O repo que te mandei é o InHouseCloud: ele transforma uma máquina só (um Mac com Docker Desktop, uma VM no seu laptop, um servidor na empresa) na "nuvem da empresa": login único (Authentik), git com deploy por push (Gitea + Actions), Postgres e Redis compartilhados, backup diário, um portal e um gateway MCP.
> A ideia: um agente de código (Claude Code, Codex) cria um app interno e coloca no ar atrás do login, sem você montar infra para cada app.
> Em 10 minutos dá para ver funcionando: um comando instala (uns 5 min) e `ihc-app new <nome> --push` põe o primeiro app no ar em uns 30 s. Passo a passo e o resto da documentação: https://inhousecloud.estoca.com.br. No Mac com Docker Desktop instala direto, sem VM; uma revisão de fora fez a instalação do zero assim: 17 de 17 testes, e os dois problemas que ela achou já foram corrigidos.
> Ou pede ao agente "instala a company cloud nesse servidor". Testamos com dois agentes diferentes, cada um numa VM limpa: o Claude Code instalou em uns 8 min, o Codex em uns 7; os dois fizeram 6 perguntas em linguagem simples e nenhuma senha apareceu na conversa. Depois, "cria um app de registro de despesas e coloca no ar" levou de 2 a 4 min, com banco próprio e login.
> Se o app já existe no seu laptop, também serve: o agente adapta o projeto e sobe por push, sem ssh nem sudo na máquina da cloud; no teste, 6 min do pedido ao deploy verde. `ihc-app init` adota um projeto que já existe.
> O portal mostra cada app com saúde e SSO, as pessoas e os grupos, e tem um status para agentes. O gateway MCP usa o login da empresa: você conecta um cliente MCP uma vez e ele vê as tools da plataforma e as dos apps, só leitura.
> Próximas etapas: acesso pela internet (ingress `public`); hoje a cloud fica na máquina ou na rede da empresa (pelo Tailscale, ingress `private`, já testado). Também faltam tools de escrita no gateway e restore de um app só.
> Os testes, com tempos e o que quebrou: docs/first-run.md.
> Se testar, me conta onde travou.

Fontes: [try-it.md](try-it.md) (instalação ~5 min, primeiro app ~30 s); [Outside operator, cold install on macOS](first-run.md#outside-operator-cold-install-on-macos-2026-10-21) (17 de 17, dois problemas corrigidos); [Cold install run](first-run.md#cold-install-run) (Claude Code: 451 s e 481 s, 6 perguntas, 0 senhas); [Cold install run with Codex](first-run.md#cold-install-run-with-codex) (instalação: 422 s de agente, 363 s de install; 6 perguntas; 0 de 22 segredos; app em 258 s); [Cold agent run](first-run.md#cold-agent-run) (app em 113 s e 141 s); [Laptop run](first-run.md#laptop-run-an-existing-app-deployed-by-push) (6 min 15 s, sem `sudo` nem `ssh`, `ihc-app init`); [Portal run](first-run.md#portal-run), [People run](first-run.md#people-run), [Portal API run](first-run.md#portal-api-run), [MCP gateway run](first-run.md#mcp-gateway-run); [Private ingress run](first-run.md#private-ingress-run).

## (b) Post (LinkedIn / Twitter, até 1.200 caracteres)

> Agente de código já escreve app interno em minutos. O que trava é o resto: onde roda, quem faz login, qual banco, quem aprova, como volta se der errado.
>
> O InHouseCloud junta SSO, git com deploy, Postgres e Redis, backup, portal e gateway MCP numa máquina só, com um contrato que o agente lê. Push na main é a aprovação.
>
> O que está provado:
> - dois agentes diferentes instalaram tudo a partir de um pedido leigo, em VM limpa: Claude Code em ~8 min, Codex em ~7, sem senha na conversa;
> - "cria um app de despesas e coloca no ar" virou app autenticado em 2 a 4 min;
> - um app escrito no laptop subiu por push, sem ssh nem sudo, em ~6 min;
> - uma revisão de fora instalou do zero num Mac com Docker Desktop: 17 de 17 testes.
>
> O portal mostra apps, saúde, SSO, pessoas e grupos. O gateway MCP usa o login da empresa: tools da plataforma e dos apps, só leitura.
>
> Próximas etapas: acesso pela internet e tools de escrita no gateway.
>
> Open source, MIT: https://github.com/Estoca/inhousecloud
> Docs e testes: https://inhousecloud.estoca.com.br

Fontes: [Cold install run](first-run.md#cold-install-run) (~8 min); [Cold install run with Codex](first-run.md#cold-install-run-with-codex) (~7 min, app em 258 s); [Cold agent run](first-run.md#cold-agent-run) (113 s e 141 s); [Laptop run](first-run.md#laptop-run-an-existing-app-deployed-by-push) (6 min 15 s); [Outside operator, cold install on macOS](first-run.md#outside-operator-cold-install-on-macos-2026-10-21) (17 de 17); [People run](first-run.md#people-run), [MCP gateway run](first-run.md#mcp-gateway-run).

## (c) Parágrafo para o README do Open Company OS

> **A nuvem da empresa está pronta para experimentar.** O [InHouseCloud](https://github.com/Estoca/inhousecloud), onde os serviços deste projeto rodam como apps comuns, instala numa máquina só o login único, o git com deploy por push, Postgres e Redis compartilhados, o backup, um portal com o catálogo de apps, a saúde e o SSO de cada um, as pessoas e os grupos, e um gateway MCP pelo login da empresa, em que um cliente MCP vê as tools da plataforma e dos apps, só leitura. Dá para ver funcionando em 10 minutos num Mac com Docker Desktop ou numa VM no laptop ([documentação](https://inhousecloud.estoca.com.br)), ou pedir a um agente de código que instale: em VMs limpas, o Claude Code e o Codex, sem contexto, instalaram a partir de um pedido leigo em cerca de 8 e 7 minutos e puseram um app novo no ar em 2 a 4. Um app que já existe no laptop sobe por push, sem ssh nem sudo, em cerca de 6 minutos ([registro dos testes](https://github.com/Estoca/inhousecloud/blob/main/docs/first-run.md)). O acesso pela internet vem numa etapa seguinte; hoje a cloud fica na máquina ou na rede da empresa.

Fontes: [try-it.md](try-it.md) (10 minutos); [Cold install run](first-run.md#cold-install-run) (~8 min); [Cold install run with Codex](first-run.md#cold-install-run-with-codex) (~7 min, app em 258 s); [Cold agent run](first-run.md#cold-agent-run) (113 s e 141 s); [Laptop run](first-run.md#laptop-run-an-existing-app-deployed-by-push) (6 min 15 s); [Portal run](first-run.md#portal-run), [People run](first-run.md#people-run), [MCP gateway run](first-run.md#mcp-gateway-run).
