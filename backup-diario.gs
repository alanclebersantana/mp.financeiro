/**
 * MP Planejamento Financeiro — backup automático diário
 *
 * Copia lançamentos, recebimentos, adiantamentos, configurações e usuários do
 * Firestore para uma pasta no seu Drive, em JSON e em planilha, todo dia.
 * Guarda os 30 backups mais recentes e apaga os antigos sozinho.
 *
 * POR QUE ISSO EXISTE
 * A tela de Backups do sistema depende de alguém clicar. Uma importação com
 * "Substituir tudo", uma regra mal publicada ou um engano em massa apaga a base
 * inteira, e o Ctrl+Z só vale para a sessão aberta. Este script é a rede embaixo.
 *
 * COMO INSTALAR (uma vez, dez minutos)
 * 1. script.google.com → Novo projeto → cole este arquivo.
 * 2. Configurações do projeto → Propriedades do script → adicione:
 *      PROJETO_ID  = mpfianceiro
 *      API_KEY     = a mesma apiKey do Firebase que está no index.html
 *      EMAIL_LOGIN = seu e-mail de acesso ao sistema
 *      SENHA_LOGIN = a senha desse e-mail no sistema
 *      PASTA_DRIVE = (opcional) id da pasta do Drive; em branco, cria "Backups MP Financeiro"
 * 3. Execute a função `backupAgora` uma vez, autorizando o acesso ao Drive.
 * 4. Acionadores (o relógio no menu lateral) → Adicionar acionador:
 *      função `backupAgora`, baseado em tempo, diário, entre 3h e 4h da manhã.
 *
 * IMPORTANTE: a conta usada precisa ter papel de leitor, operador ou admin no
 * sistema, porque as regras do Firestore exigem login. Crie uma conta só para
 * isso se preferir não usar a sua.
 */

var COLECOES = ['lancamentos', 'recebimentos', 'adiantamentos', 'usuarios', 'auditoria'];
var DOCS_CONFIG = ['saldo', 'estoque', 'limites'];
var MANTER = 30;   // quantos backups guardar

function backupAgora() {
  var props = PropertiesService.getScriptProperties();
  var token = autenticar(props);
  var dados = { gerado: new Date().toISOString(), projeto: props.getProperty('PROJETO_ID'), colecoes: {}, config: {} };

  COLECOES.forEach(function (col) {
    dados.colecoes[col] = lerColecao(props, token, col);
  });
  DOCS_CONFIG.forEach(function (doc) {
    var d = lerDocumento(props, token, 'config/' + doc);
    if (d) dados.config[doc] = d;
  });

  var pasta = pastaDoBackup(props);
  var carimbo = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM-dd_HH-mm');

  pasta.createFile('mp-backup-' + carimbo + '.json', JSON.stringify(dados, null, 1), MimeType.PLAIN_TEXT);
  planilhaDoBackup(dados, pasta, carimbo);
  limparAntigos(pasta);

  var resumo = COLECOES.map(function (c) { return c + ': ' + dados.colecoes[c].length; }).join(' · ');
  Logger.log('Backup concluído — ' + resumo);
  return resumo;
}

/** entra no Firebase com e-mail e senha, como um usuário comum do sistema */
function autenticar(props) {
  var chave = props.getProperty('API_KEY');
  var res = UrlFetchApp.fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + chave,
    { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ email: props.getProperty('EMAIL_LOGIN'), password: props.getProperty('SENHA_LOGIN'), returnSecureToken: true }) });
  var dados = JSON.parse(res.getContentText());
  if (!dados.idToken) throw new Error('Não consegui entrar: ' + (dados.error && dados.error.message));
  return dados.idToken;
}

function lerColecao(props, token, colecao) {
  var base = 'https://firestore.googleapis.com/v1/projects/' + props.getProperty('PROJETO_ID') +
             '/databases/(default)/documents/' + colecao + '?pageSize=300';
  var saida = [], pagina = '';
  do {
    var res = UrlFetchApp.fetch(base + (pagina ? '&pageToken=' + pagina : ''),
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error(colecao + ': ' + res.getContentText().slice(0, 200));
    var dados = JSON.parse(res.getContentText());
    (dados.documents || []).forEach(function (doc) {
      var item = converter(doc.fields);
      item.id = doc.name.split('/').pop();
      saida.push(item);
    });
    pagina = dados.nextPageToken || '';
  } while (pagina);
  return saida;
}

function lerDocumento(props, token, caminho) {
  var res = UrlFetchApp.fetch(
    'https://firestore.googleapis.com/v1/projects/' + props.getProperty('PROJETO_ID') + '/databases/(default)/documents/' + caminho,
    { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  return converter(JSON.parse(res.getContentText()).fields);
}

/** traduz o formato do Firestore para valores simples */
function converter(campos) {
  var saida = {};
  Object.keys(campos || {}).forEach(function (k) {
    var v = campos[k];
    if (v.stringValue !== undefined) saida[k] = v.stringValue;
    else if (v.integerValue !== undefined) saida[k] = Number(v.integerValue);
    else if (v.doubleValue !== undefined) saida[k] = Number(v.doubleValue);
    else if (v.booleanValue !== undefined) saida[k] = v.booleanValue;
    else if (v.nullValue !== undefined) saida[k] = null;
    else if (v.timestampValue !== undefined) saida[k] = v.timestampValue;
    else if (v.mapValue !== undefined) saida[k] = converter(v.mapValue.fields);
    else if (v.arrayValue !== undefined) saida[k] = (v.arrayValue.values || []).map(function (x) {
      return x.stringValue !== undefined ? x.stringValue
           : x.integerValue !== undefined ? Number(x.integerValue)
           : x.doubleValue !== undefined ? Number(x.doubleValue)
           : x.mapValue ? converter(x.mapValue.fields) : null;
    });
  });
  return saida;
}

/** uma planilha por backup, com uma aba por coleção — dá para abrir e conferir a olho */
function planilhaDoBackup(dados, pasta, carimbo) {
  var ss = SpreadsheetApp.create('mp-backup-' + carimbo);
  ['lancamentos', 'recebimentos', 'adiantamentos'].forEach(function (col, i) {
    var linhas = dados.colecoes[col] || [];
    var aba = i === 0 ? ss.getSheets()[0] : ss.insertSheet();
    aba.setName(col);
    if (!linhas.length) { aba.getRange(1, 1).setValue('sem registros'); return; }
    var colunas = Object.keys(linhas.reduce(function (acc, l) {
      Object.keys(l).forEach(function (k) { acc[k] = 1; }); return acc;
    }, {}));
    var matriz = [colunas].concat(linhas.map(function (l) {
      return colunas.map(function (c) { return l[c] === undefined || l[c] === null ? '' : (typeof l[c] === 'object' ? JSON.stringify(l[c]) : l[c]); });
    }));
    aba.getRange(1, 1, matriz.length, colunas.length).setValues(matriz);
    aba.setFrozenRows(1);
  });
  var arquivo = DriveApp.getFileById(ss.getId());
  pasta.addFile(arquivo);
  DriveApp.getRootFolder().removeFile(arquivo);
}

function pastaDoBackup(props) {
  var id = props.getProperty('PASTA_DRIVE');
  if (id) return DriveApp.getFolderById(id);
  var achou = DriveApp.getFoldersByName('Backups MP Financeiro');
  return achou.hasNext() ? achou.next() : DriveApp.createFolder('Backups MP Financeiro');
}

/** mantém só os backups mais recentes */
function limparAntigos(pasta) {
  var arquivos = [];
  var it = pasta.getFiles();
  while (it.hasNext()) { var f = it.next(); arquivos.push({ f: f, data: f.getDateCreated().getTime() }); }
  arquivos.sort(function (a, b) { return b.data - a.data; });
  arquivos.slice(MANTER * 2).forEach(function (x) { x.f.setTrashed(true); });   // json + planilha por dia
}
