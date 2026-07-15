/**
 * TerraZoo — Backend do Gerenciador de Tarefas (tarefas.html)
 *
 * COMO USAR:
 * 1. Crie uma Planilha Google nova (qualquer nome).
 * 2. Menu Extensões → Apps Script.
 * 3. Apague o conteúdo de Code.gs e cole este arquivo inteiro.
 * 4. Clique em Implantar → Nova implantação → tipo "App da Web".
 *    - Executar como: Eu (sua conta)
 *    - Quem pode acessar: Qualquer pessoa (ou "Qualquer pessoa com o link")
 * 5. Copie a URL do App da Web (termina em /exec) e cole em
 *    tarefas.html → botão ⚙️ Configurações → "URL do backend".
 * 6. (Automatiza lembretes de prazo e tarefas recorrentes) No editor do
 *    Apps Script, selecione a função "criarAcionadorDiario" no menu
 *    suspenso ao lado do botão ▶ Executar, e clique Executar UMA VEZ
 *    (a primeira execução pede autorização — aceite). Isso instala os
 *    gatilhos diários automaticamente; não precisa mexer na tela de
 *    Acionadores manualmente depois disso.
 *
 * O e-mail é enviado via MailApp usando a própria conta Google que
 * implantou o script — não precisa de senha nem API paga.
 */

const ABA_USUARIOS = 'Usuarios';
const ABA_DEPARTAMENTOS = 'Departamentos';
const ABA_COLUNAS = 'Colunas';
const ABA_REUNIOES = 'Reunioes';
const ABA_TAREFAS = 'Tarefas';
const ABA_HISTORICO = 'Historico';

const CAMPOS_JSON = ['checklist', 'comentarios', 'recorrencia'];

const CABECALHOS = {
  Usuarios: ['id', 'nome', 'email', 'whatsapp', 'departamentoId', 'cargo', 'funcao', 'ativo', 'master', 'senha', 'precisaTrocarSenha'],
  Departamentos: ['id', 'nome', 'cor'],
  Colunas: ['id', 'nome', 'ordem', 'final', 'limite'],
  Reunioes: ['id', 'titulo', 'data', 'arquivada', 'arquivadaEm'],
  Tarefas: ['id', 'titulo', 'descricao', 'departamentoId', 'responsavelId', 'colunaId', 'prioridade', 'prazo', 'reuniaoId', 'criadoPor', 'criadoEm', 'concluidoEm', 'ordem', 'checklist', 'notificadoPrazo', 'comentarios', 'recorrencia', 'ultimaGeracaoEm', 'arquivada', 'arquivadaEm'],
  Historico: ['id', 'ts', 'usuarioId', 'entidade', 'entidadeId', 'acao', 'detalhes']
};

const COLUNAS_PADRAO = [
  { id: 'c1', nome: 'A Fazer', ordem: 0, final: false, limite: 0 },
  { id: 'c2', nome: 'Em Andamento', ordem: 1, final: false, limite: 0 },
  { id: 'c3', nome: 'Em Revisão', ordem: 2, final: false, limite: 0 },
  { id: 'c4', nome: 'Concluído', ordem: 3, final: true, limite: 0 }
];

/* Usuário master pré-configurado — mesmos IDs usados em tarefas.html,
   para que os dois lados (local e backend) reconheçam o mesmo registro. */
const DEPTO_MASTER = { id: 'd_controladoria', nome: 'Controladoria', cor: '#1a2e1f' };
/* senha: hash SHA-256 de "123456" (mesma senha padrão usada no front-end) —
   precisaTrocarSenha força a troca no primeiro acesso, igual a qualquer outro usuário.
   Sem departamento: o usuário master é só conta de login, não aparece como responsável. */
const USUARIO_MASTER = {
  id: 'usr_master_fadrick',
  nome: 'Fadrick Leveghin',
  email: '',
  departamentoId: '',
  cargo: 'admin',
  ativo: true,
  master: true,
  senha: '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92',
  precisaTrocarSenha: true
};

/* ═══════════════════════ ENTRADAS HTTP ═══════════════════════ */

function doGet(e) {
  garantirEstrutura_();
  return respostaJson_(obterTudo_());
}

function doPost(e) {
  garantirEstrutura_();
  const corpo = JSON.parse(e.postData.contents);
  const acao = corpo.acao;
  let resultado = { ok: true };

  // Evita condição de corrida quando duas pessoas mexem no quadro ao mesmo tempo:
  // cada requisição de escrita espera a vez antes de ler/gravar na planilha.
  const lock = LockService.getScriptLock();
  const obtido = lock.tryLock(10000);
  if (!obtido) {
    return respostaJson_({ ok: false, erro: 'Não foi possível obter o bloqueio da planilha (outra edição em andamento). Tente novamente.' });
  }

  try {
    switch (acao) {
      case 'salvarUsuario': salvarLinha_(ABA_USUARIOS, corpo.dado); break;
      case 'removerUsuario':
        if (corpo.id === USUARIO_MASTER.id) { resultado = { ok: false, erro: 'O usuário master não pode ser excluído.' }; break; }
        removerLinha_(ABA_USUARIOS, corpo.id);
        break;
      case 'salvarDepartamento': salvarLinha_(ABA_DEPARTAMENTOS, corpo.dado); break;
      case 'removerDepartamento': removerLinha_(ABA_DEPARTAMENTOS, corpo.id); break;
      case 'salvarColuna': salvarLinha_(ABA_COLUNAS, corpo.dado); break;
      case 'removerColuna': removerLinha_(ABA_COLUNAS, corpo.id); break;
      case 'salvarReuniao': salvarLinha_(ABA_REUNIOES, corpo.dado); break;
      case 'removerReuniao': removerLinha_(ABA_REUNIOES, corpo.id); break;
      case 'salvarTarefa':
        salvarLinha_(ABA_TAREFAS, normalizarTarefa_(corpo.dado));
        notificarSeAtribuida_(corpo.dado);
        break;
      case 'moverTarefa': moverTarefa_(corpo.id, corpo.colunaId, corpo.ordem); break;
      case 'removerTarefa': removerLinha_(ABA_TAREFAS, corpo.id); break;
      case 'notificarEmail': resultado.enviado = notificarEmailTarefa_(corpo.id); break;
      case 'registrarHistorico': salvarLinha_(ABA_HISTORICO, corpo.dado); break;
      default: resultado = { ok: false, erro: 'Ação desconhecida: ' + acao };
    }
  } catch (err) {
    resultado = { ok: false, erro: String(err) };
  } finally {
    lock.releaseLock();
  }

  return respostaJson_(resultado);
}

function respostaJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ═══════════════════════ ESTRUTURA DA PLANILHA ═══════════════════════ */

function garantirEstrutura_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(CABECALHOS).forEach(nomeAba => {
    let aba = ss.getSheetByName(nomeAba);
    if (!aba) {
      aba = ss.insertSheet(nomeAba);
      aba.appendRow(CABECALHOS[nomeAba]);
    }
  });
  const abaColunas = ss.getSheetByName(ABA_COLUNAS);
  if (abaColunas.getLastRow() < 2) {
    COLUNAS_PADRAO.forEach(c => salvarLinha_(ABA_COLUNAS, c));
  }

  // Semeia "Controladoria" só na primeira vez (planilha de departamentos vazia) —
  // depois disso, se o usuário excluir o departamento, ele não deve voltar sozinho.
  const abaDepartamentos = ss.getSheetByName(ABA_DEPARTAMENTOS);
  if (abaDepartamentos.getLastRow() < 2) {
    salvarLinha_(ABA_DEPARTAMENTOS, DEPTO_MASTER);
  }

  const usuarios = lerAba_(ABA_USUARIOS);
  const masterExistente = usuarios.find(u => u.master === true || u.master === 'TRUE' || u.id === USUARIO_MASTER.id);
  if (!masterExistente) {
    salvarLinha_(ABA_USUARIOS, USUARIO_MASTER);
  } else if (masterExistente.departamentoId) {
    // migração: usuário master não tem mais departamento associado (é só conta de login)
    masterExistente.departamentoId = '';
    salvarLinha_(ABA_USUARIOS, masterExistente);
  }
}

function obterAba_(nome) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nome);
}

function lerAba_(nome) {
  const aba = obterAba_(nome);
  const valores = aba.getDataRange().getValues();
  const cabecalho = valores[0];
  return valores.slice(1).filter(l => l[0] !== '').map(linha => {
    const obj = {};
    cabecalho.forEach((chave, i) => { obj[chave] = linha[i]; });
    CAMPOS_JSON.forEach(campo => {
      if (obj[campo] && typeof obj[campo] === 'string') {
        try { obj[campo] = JSON.parse(obj[campo]); } catch (e) { obj[campo] = campo === 'recorrencia' ? { tipo: 'nenhuma' } : []; }
      }
    });
    return obj;
  });
}

function salvarLinha_(nomeAba, dado) {
  const aba = obterAba_(nomeAba);
  const cabecalho = CABECALHOS[nomeAba];
  const dadoCopia = Object.assign({}, dado);
  CAMPOS_JSON.forEach(campo => {
    if (dadoCopia[campo] && typeof dadoCopia[campo] !== 'string') {
      dadoCopia[campo] = JSON.stringify(dadoCopia[campo]);
    }
  });
  const valores = aba.getDataRange().getValues();
  for (let i = 1; i < valores.length; i++) {
    if (valores[i][0] === dadoCopia.id) {
      const linha = cabecalho.map(chave => dadoCopia[chave] !== undefined ? dadoCopia[chave] : '');
      aba.getRange(i + 1, 1, 1, cabecalho.length).setValues([linha]);
      return;
    }
  }
  const linha = cabecalho.map(chave => dadoCopia[chave] !== undefined ? dadoCopia[chave] : '');
  aba.appendRow(linha);
}

function removerLinha_(nomeAba, id) {
  const aba = obterAba_(nomeAba);
  const valores = aba.getDataRange().getValues();
  for (let i = 1; i < valores.length; i++) {
    if (valores[i][0] === id) {
      aba.deleteRow(i + 1);
      return;
    }
  }
}

function normalizarTarefa_(dado) {
  return dado;
}

function moverTarefa_(id, colunaId, ordem) {
  const aba = obterAba_(ABA_TAREFAS);
  const cabecalho = CABECALHOS[ABA_TAREFAS];
  const idxColuna = cabecalho.indexOf('colunaId');
  const idxOrdem = cabecalho.indexOf('ordem');
  const valores = aba.getDataRange().getValues();
  for (let i = 1; i < valores.length; i++) {
    if (valores[i][0] === id) {
      aba.getRange(i + 1, idxColuna + 1).setValue(colunaId);
      aba.getRange(i + 1, idxOrdem + 1).setValue(ordem);
      return;
    }
  }
}

function obterTudo_() {
  return {
    usuarios: lerAba_(ABA_USUARIOS),
    departamentos: lerAba_(ABA_DEPARTAMENTOS),
    colunas: lerAba_(ABA_COLUNAS),
    reunioes: lerAba_(ABA_REUNIOES),
    tarefas: lerAba_(ABA_TAREFAS),
    historico: lerAba_(ABA_HISTORICO)
  };
}

/* ═══════════════════════ NOTIFICAÇÕES POR E-MAIL ═══════════════════════ */

function notificarSeAtribuida_(dado) {
  if (dado && dado.responsavelId) {
    notificarEmailTarefa_(dado.id);
  }
}

function notificarEmailTarefa_(tarefaId) {
  const tarefas = lerAba_(ABA_TAREFAS);
  const tarefa = tarefas.find(t => t.id === tarefaId);
  if (!tarefa || !tarefa.responsavelId) return false;

  const usuarios = lerAba_(ABA_USUARIOS);
  const responsavel = usuarios.find(u => u.id === tarefa.responsavelId);
  if (!responsavel || !responsavel.email) return false;

  const departamentos = lerAba_(ABA_DEPARTAMENTOS);
  const dep = departamentos.find(d => d.id === tarefa.departamentoId);

  const assunto = 'Tarefa TerraZoo: ' + tarefa.titulo;
  let corpo = 'Olá ' + responsavel.nome.split(' ')[0] + ',\n\n';
  corpo += 'Você tem uma tarefa no quadro de gerenciamento TerraZoo:\n\n';
  corpo += 'Tarefa: ' + tarefa.titulo + '\n';
  if (dep) corpo += 'Departamento: ' + dep.nome + '\n';
  if (tarefa.prioridade) corpo += 'Prioridade: ' + tarefa.prioridade + '\n';
  if (tarefa.prazo) corpo += 'Prazo: ' + tarefa.prazo + '\n';
  if (tarefa.descricao) corpo += '\nDetalhes: ' + tarefa.descricao + '\n';

  MailApp.sendEmail(responsavel.email, assunto, corpo);
  return true;
}

/**
 * Lembrete diário de prazos. Configure um acionador de tempo (ver
 * instruções no topo do arquivo) para chamar esta função uma vez por dia.
 * Envia e-mail apenas uma vez por tarefa (marca notificadoPrazo = true).
 */
function verificarPrazos() {
  garantirEstrutura_();
  const hoje = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const colunas = lerAba_(ABA_COLUNAS);
  const colunasFinais = new Set(colunas.filter(c => c.final === true || c.final === 'TRUE').map(c => c.id));
  const usuarios = lerAba_(ABA_USUARIOS);
  const tarefas = lerAba_(ABA_TAREFAS);

  tarefas.forEach(t => {
    if (!t.prazo || t.notificadoPrazo === true || t.notificadoPrazo === 'TRUE') return;
    if (colunasFinais.has(t.colunaId)) return;
    if (String(t.prazo).slice(0, 10) > hoje) return;

    const responsavel = usuarios.find(u => u.id === t.responsavelId);
    if (responsavel && responsavel.email) {
      MailApp.sendEmail(
        responsavel.email,
        'Prazo da tarefa "' + t.titulo + '" venceu ou vence hoje',
        'Olá ' + responsavel.nome.split(' ')[0] + ',\n\nA tarefa "' + t.titulo + '" tem prazo em ' + t.prazo + ' e ainda não foi concluída.\n\nAcesse o quadro TerraZoo para atualizá-la.'
      );
    }
    salvarLinha_(ABA_TAREFAS, Object.assign({}, t, { notificadoPrazo: true }));
  });
}

/**
 * Gera automaticamente a próxima instância de tarefas com recorrência
 * mensal (recorrencia.tipo === 'mensal'), assim que o dia do mês
 * configurado (diaBase) chega e ainda não foi gerada este mês.
 * Registra o evento na aba Historico. Chame diariamente via acionador
 * (ver criarAcionadorDiario).
 */
function verificarRecorrencias() {
  garantirEstrutura_();
  const agora = new Date();
  const anoMes = Utilities.formatDate(agora, Session.getScriptTimeZone(), 'yyyy-MM');
  const diaAtual = Number(Utilities.formatDate(agora, Session.getScriptTimeZone(), 'd'));
  const colunas = lerAba_(ABA_COLUNAS).sort((a, b) => a.ordem - b.ordem);
  const primeiraColuna = colunas[0];
  if (!primeiraColuna) return;
  const tarefas = lerAba_(ABA_TAREFAS);

  tarefas.forEach(t => {
    const rec = t.recorrencia;
    if (!rec || rec.tipo !== 'mensal') return;
    if (t.ultimaGeracaoEm === anoMes) return;
    if (diaAtual < rec.diaBase) return;

    const nova = {
      id: Utilities.getUuid(), titulo: t.titulo, descricao: t.descricao, departamentoId: t.departamentoId,
      responsavelId: t.responsavelId, colunaId: primeiraColuna.id, prioridade: t.prioridade,
      prazo: anoMes + '-' + String(rec.diaBase).padStart(2, '0'), reuniaoId: '',
      criadoPor: t.criadoPor, criadoEm: Utilities.formatDate(agora, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      concluidoEm: '', ordem: tarefas.filter(x => x.colunaId === primeiraColuna.id).length,
      checklist: (t.checklist || []).map(c => ({ id: Utilities.getUuid(), texto: c.texto, feito: false })),
      comentarios: [], recorrencia: { tipo: 'nenhuma' }, ultimaGeracaoEm: ''
    };
    salvarLinha_(ABA_TAREFAS, nova);
    salvarLinha_(ABA_TAREFAS, Object.assign({}, t, { ultimaGeracaoEm: anoMes }));
    salvarLinha_(ABA_HISTORICO, {
      id: Utilities.getUuid(), ts: agora.toISOString(), usuarioId: '', entidade: 'tarefa', entidadeId: nova.id,
      acao: 'criar', detalhes: 'Gerada automaticamente pela recorrência mensal de "' + t.titulo + '"'
    });
  });
}

/**
 * Instala (uma única vez) os gatilhos diários que substituem a
 * necessidade de configurar acionadores manualmente pela interface.
 * Selecione esta função no editor do Apps Script e clique em ▶ Executar.
 * É seguro rodar mais de uma vez: não duplica gatilhos já existentes.
 */
function criarAcionadorDiario() {
  const funcoesAgendadas = ['verificarPrazos', 'verificarRecorrencias'];
  const existentes = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  funcoesAgendadas.forEach(nomeFuncao => {
    if (existentes.indexOf(nomeFuncao) === -1) {
      ScriptApp.newTrigger(nomeFuncao).timeBased().everyDays(1).atHour(8).create();
    }
  });
  Logger.log('Gatilhos diários instalados (ou já existentes): ' + funcoesAgendadas.join(', '));
}
