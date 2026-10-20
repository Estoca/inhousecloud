# Announcement drafts

Three texts in Portuguese, for review before anyone posts them. Every number comes from a test record in [`first-run.md`](first-run.md) or from the timed run in [`try-it.md`](try-it.md); the link to the record goes along with them.

## (a) Mensagem para quem recebeu o repositório

> Oi! O repo que te mandei é o Open Company App Harness: ele transforma uma máquina só (um VPS, ou uma VM no seu laptop) na "nuvem da empresa": login único (Authentik), git com deploy (Gitea + Actions), Postgres e Redis compartilhados e backup diário.
> A ideia: um agente de código (Claude Code, Codex) cria um app interno e coloca no ar atrás do login, sem você montar infra para cada app.
> Em 10 minutos dá para ver funcionando: sobe uma VM com o Lima, um comando instala (uns 5 min) e `harness-app new <nome> --push` põe o primeiro app no ar em uns 30 s. Passo a passo: docs/try-it.md.
> Ou pede ao Claude Code "instala a company cloud nesse servidor": num teste com uma VM limpa, ele instalou sozinho em uns 8 min, fez 6 perguntas em linguagem simples e não mostrou nenhuma senha.
> Depois, "cria um app de registro de despesas e coloca no ar" levou uns 2 min, com banco próprio e login.
> O que ainda não está pronto: no Mac roda só dentro de uma VM; acesso pela internet ou pela rede da empresa (ingress `public` e `private`) está no instalador, mas não foi testado de ponta a ponta (hoje é na própria máquina ou por túnel SSH); o portal ainda é um placeholder.
> Os testes, com tempos e o que quebrou: docs/first-run.md.
> Se testar, me conta onde travou.

## (b) Post (LinkedIn / Twitter, até 1.200 caracteres)

> Agente de código já escreve app interno em minutos. O que trava é o resto: onde roda, quem faz login, qual banco, quem aprova, como volta se der errado.
>
> A tese do Open Company App Harness: a união é o produto. SSO + git com deploy + Postgres e Redis compartilhados + backup, numa máquina só, com um contrato que o agente consegue ler. Push na main é a aprovação; o deploy dá ao app banco próprio, rota e login, sem senha no chat.
>
> O que está provado, em VM limpa:
> - um agente que nunca viu o projeto instalou a plataforma a partir de um pedido leigo em ~8 min, 18 de 18 testes, nenhuma senha na conversa;
> - "cria um app de registro de despesas e coloca no ar" virou app autenticado, com banco próprio, em ~2 min;
> - na mão: ~5 min de instalação e ~30 s do primeiro app.
>
> Não é PaaS nem Kubernetes: é o primeiro estágio, em que a empresa precisa que software interno seja real, autenticado e repetível.
>
> Open source, MIT: https://github.com/Estoca/open-company-app-harness
> Registro dos testes: https://github.com/Estoca/open-company-app-harness/blob/main/docs/first-run.md

## (c) Parágrafo para o README do Open Company OS

> **O cloud está pronto para experimentar.** O [Open Company App Harness](https://github.com/Estoca/open-company-app-harness), onde os serviços deste projeto rodam como apps comuns, instala numa máquina só o login único, o git com deploy por push, Postgres e Redis compartilhados e o backup. Dá para ver funcionando em 10 minutos numa VM no laptop ([`docs/try-it.md`](https://github.com/Estoca/open-company-app-harness/blob/main/docs/try-it.md)), ou pedir a um agente de código que instale: em VM limpa, um agente sem contexto instalou a partir de um pedido leigo em cerca de 8 minutos e pôs um app novo no ar em cerca de 2 ([registro dos testes](https://github.com/Estoca/open-company-app-harness/blob/main/docs/first-run.md)). Ainda faltam o portal de verdade e o acesso pela internet testado de ponta a ponta.
