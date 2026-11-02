# Segurança

O Nexo é um serviço local para um usuário confiável do sistema operacional. Não é um serviço de colaboração exposto na rede.

- HTTP liga em 127.0.0.1, valida Host/Origin e rejeita requisições cross-site.
- Apenas o runtime MCP recebe o bearer token persistido em `.nexo/local/`.
- O browser recebe um ticket de 60 segundos, consumido uma vez; troca por cookie HttpOnly SameSite Strict. O fragmento é removido do histórico.
- Cookies de sessão valem oito horas e são invalidados ao reiniciar o serviço.
- O board é somente leitura. Comandos, claims e resolução requerem bearer, não cookie de navegador.
- CSP, ausência de CDNs, componentes React com texto escapado, limite de corpo e SQL parametrizado reduzem superfícies de ataque.
- Não se executa código vindo de cards, arquivos de eventos ou URLs de evidência.
- Os hooks usam exec form com argv, sem avaliação por shell. O helper de sessão não usa bypass de permissões.
- Dados de projeto `.nexo/` e arquivos `.claude/` devem ser revisados antes de executar plugins em repositório não confiável.

Leases são coordenação. Não isolam processos do mesmo usuário, impedem edição por outro editor ou provam respeito ao escopo em comandos arbitrários de shell. Hooks Write/Edit conferem escopos relativos e rejeitam symlinks; shell exige uma claim e continua sob as permissões normais do Claude. Revisores não devem executar comandos que escrevem.

Arquivos locais usam permissões restritas quando suportadas; no Windows, a proteção efetiva depende das ACLs herdadas do diretório do usuário. Não coloque a pasta local em diretório compartilhado com usuários não confiáveis. Nenhum token deve ser commitado. Atributos Git de SQLite são binários; eventos não são criptografados. Não registre segredos nos títulos, resultados ou evidências.

Reporte falhas privadamente ao proprietário do repositório. Não abra issues públicas com tokens, prompts sensíveis ou conteúdo de projetos privados.
