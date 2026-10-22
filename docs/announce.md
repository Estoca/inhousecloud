# Announcement drafts

Three texts in Portuguese, for review before anyone posts them. Every number comes from a test record in [`first-run.md`](first-run.md) or from the timed run in [`try-it.md`](try-it.md); the link to the record goes along with them.

## (a) Mensagem para quem recebeu o repositório

> Oi! O repo que te mandei é o InHouseCloud: ele transforma uma máquina só (um VPS, um Mac com Docker Desktop ou uma VM no seu laptop) na "nuvem da empresa": login único (Authentik), git com deploy (Gitea + Actions), Postgres e Redis compartilhados, backup diário e um portal.
> A ideia: um agente de código (Claude Code, Codex) cria um app interno e coloca no ar atrás do login, sem você montar infra para cada app.
> Em 10 minutos dá para ver funcionando: um comando instala (uns 5 min) e `ihc-app new <nome> --push` põe o primeiro app no ar em uns 30 s. Passo a passo: docs/try-it.md. No Mac com Docker Desktop instala direto, sem VM; uma revisora de fora fez a instalação do zero assim: 17 de 17 testes, doctor em menos de 4 s.
> O portal mostra cada app com saúde e SSO, os deploys e o status da plataforma (só leitura; admin por grupo). E `ihc doctor` confere a máquina em segundos (16 verificações, mais uma por app) e diz o que fazer em cada falha.
> Ou pede ao Claude Code "instala a company cloud nesse servidor": num teste com uma VM limpa, ele instalou sozinho em uns 8 min, fez 6 perguntas em linguagem simples e não mostrou nenhuma senha. Depois, "cria um app de registro de despesas e coloca no ar" levou uns 2 min, com banco próprio e login.
> O que ainda não está pronto: acesso pela internet (ingress `public`) está no instalador, mas não foi testado de ponta a ponta (pelo Tailscale, ingress `private`, já foi); o portal ainda não lê pessoas e grupos do Authentik; e ainda não tem gateway MCP.
> Os testes, com tempos e o que quebrou: docs/first-run.md.
> Se testar, me conta onde travou.

## (b) Post (LinkedIn / Twitter, até 1.200 caracteres)

> Agente de código já escreve app interno em minutos. O que trava é o resto: onde roda, quem faz login, qual banco, quem aprova, como volta se der errado.
>
> O InHouseCloud junta SSO, git com deploy, Postgres e Redis, backup e um portal numa máquina só, com um contrato que o agente lê. Push na main é a aprovação; o app ganha banco, rota e login.
>
> O que está provado:
> - um agente que nunca viu o projeto instalou tudo a partir de um pedido leigo em ~8 min, sem senha na conversa;
> - "cria um app de despesas e coloca no ar" virou app autenticado em ~2 min;
> - na mão: ~5 min de instalação, ~30 s do primeiro app;
> - uma revisora de fora instalou do zero num Mac com Docker Desktop: 17 de 17 testes.
>
> O portal mostra apps, saúde, SSO, deploys e status, só leitura. `ihc doctor` diz o que está quebrado e o que fazer.
>
> Falta: acesso pela internet testado de ponta a ponta, pessoas e grupos no portal, gateway MCP.
>
> Open source, MIT: https://github.com/Estoca/inhousecloud
> Testes: https://github.com/Estoca/inhousecloud/blob/main/docs/first-run.md

## (c) Parágrafo para o README do Open Company OS

> **A nuvem da empresa está pronta para experimentar.** O [InHouseCloud](https://github.com/Estoca/inhousecloud), onde os serviços deste projeto rodam como apps comuns, instala numa máquina só o login único, o git com deploy por push, Postgres e Redis compartilhados, o backup e um portal só de leitura com o catálogo de apps, a saúde e o SSO de cada um, os deploys e o status da plataforma. Dá para ver funcionando em 10 minutos num Mac com Docker Desktop ou numa VM no laptop ([`docs/try-it.md`](https://github.com/Estoca/inhousecloud/blob/main/docs/try-it.md)), ou pedir a um agente de código que instale: em VM limpa, um agente sem contexto instalou a partir de um pedido leigo em cerca de 8 minutos e pôs um app novo no ar em cerca de 2 ([registro dos testes](https://github.com/Estoca/inhousecloud/blob/main/docs/first-run.md)). Ainda faltam o acesso pela internet testado de ponta a ponta, o portal ler pessoas e grupos do Authentik e um gateway MCP para os agentes.
