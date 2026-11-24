# Derrubada de Árvores

Mod **oficial** do [MineClaude](https://mineclaude.com). Id `derrubada`, versão `0.1.0`. Repositório público.

Este mod **vem junto** com o servidor oficial: quem joga em https://mineclaude.com já tem ele. Este
repositório é para quem hospeda o próprio servidor, ou quer ler como ele é feito.

> Num servidor que já traz este mod como **pasta** na `MODS_DIR` (`mods/derrubada/`), não ponha o
> `.mcmod` do lado: seriam dois mods com o id `derrubada`. Use um ou o outro.

## O que ele faz

Corte o pé da árvore com um machado e ela tomba INTEIRA, como um corpo rígido: uma entidade, uma malha, física no servidor a 20 Hz. Bate no que houver no caminho, repica, deita, e só então vira tora e partícula de folha. Regras de jogo derrubada:arvores e derrubada:dano_arvore.

## Instalar

Baixe o `.mcmod` da [última Release](../../releases/latest) e escolha um caminho:

- **Pasta de mods:** ponha o arquivo **`derrubada.mcmod`** (o nome importa: o servidor exige que seja o id do mod) na `MODS_DIR` do servidor e reinicie. A Release traz esse nome pronto, ao lado da cópia com a versão no nome.
- **No jogo:** `/mod previa <link do .mcmod>`, ou a tela **Mods**.

Lado: servidor + navegador.

## Configuração

Chaves do bloco `mineclaude.config` do `package.json`, ajustáveis pelo servidor:

| chave | padrão |
| --- | --- |
| `comandos_de_teste` | `false` |

## Montar e empacotar aqui

Só precisa do [Bun](https://bun.sh) — nada do repositório do jogo:

```
bun tools/pack.mjs
```

Sai um `derrubada-0.1.0.mcmod` determinístico (mesma entrada, mesmos bytes).

## Publicar uma versão

Suba a `version` no `package.json`, comite, e marque:

```
git tag v0.1.0 && git push origin v0.1.0
```

O workflow `.github/workflows/release.yml` monta, empacota e cria a Release com o `.mcmod` anexado.

## Arte

Arte 100% original, pintada por código.
