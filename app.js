'use strict';

const $ = (id) => document.getElementById(id);

const btnSeleccionar = $('btnSeleccionar');
const inputCarpeta = $('inputCarpeta');
const estado = $('estado');
const resultado = $('resultado');
const tablaFacturas = $('tablaFacturas');
const tablaImpuestos = $('tablaImpuestos');
const btnExpandirTodo = $('btnExpandirTodo');
const bloqueErrores = $('bloqueErrores');
const listaErrores = $('listaErrores');

const COLUMNAS_FACTURA = 11;
const NOMBRE_IMPUESTO = { '001': 'ISR', '002': 'IVA', '003': 'IEPS' };

const formatoMoneda = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const formatoCantidad = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 6 });
const formatoPorcentaje = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 4 });

// Evita que el resultado de una selección anterior pise al de una más reciente
let seleccionActual = 0;

btnSeleccionar.addEventListener('click', () => inputCarpeta.click());

inputCarpeta.addEventListener('change', async () => {
  const archivos = Array.from(inputCarpeta.files);
  // Permite volver a seleccionar la misma carpeta y disparar "change" otra vez
  inputCarpeta.value = '';

  const idSeleccion = ++seleccionActual;
  const xmls = filtrarXml(archivos);

  if (archivos.length === 0) {
    mostrarEstado('La carpeta seleccionada está vacía.', true);
    resultado.hidden = true;
    return;
  }

  if (xmls.length === 0) {
    mostrarEstado(`No se encontraron archivos XML en la carpeta (${archivos.length} archivos revisados).`, true);
    resultado.hidden = true;
    return;
  }

  mostrarEstado(`Leyendo ${xmls.length} archivos XML...`);
  const reporte = await procesarXmls(xmls);
  if (idSeleccion !== seleccionActual) return;

  const carpeta = (xmls[0].webkitRelativePath || '').split('/')[0];
  mostrarEstado(
    `Carpeta "${carpeta}": ${reporte.facturas.length} de ${xmls.length} XML leídos como facturas CFDI.`,
    reporte.facturas.length === 0
  );
  mostrarReporte(archivos.length, reporte);
});

btnExpandirTodo.addEventListener('click', () => {
  const bloques = tablaFacturas.querySelectorAll('tbody.factura');
  const hayExpandidas = Array.from(bloques).some((b) => !b.classList.contains('contraida'));
  bloques.forEach((b) => expandirFactura(b, !hayExpandidas));
  actualizarBotonExpandir();
});

function filtrarXml(archivos) {
  return archivos.filter((f) => f.name.toLowerCase().endsWith('.xml'));
}

// ---------- Lectura y cálculo ----------

// Se suma en centavos (enteros) para evitar errores de punto flotante
const centavos = (n) => Math.round(n * 100);

async function procesarXmls(xmls) {
  const resultados = await Promise.all(xmls.map(leerFactura));

  const facturas = [];
  const errores = [];
  for (const r of resultados) {
    if (r.error) errores.push(r);
    else facturas.push(r);
  }

  facturas.sort((a, b) => a.fecha.localeCompare(b.fecha));

  let subtotal = 0;
  let total = 0;
  let trasladados = 0;
  let retenidos = 0;
  const categorias = new Map();

  for (const f of facturas) {
    subtotal += centavos(f.subtotal);
    total += centavos(f.total);
    trasladados += centavos(f.trasladados);
    retenidos += centavos(f.retenidos);

    for (const imp of f.impuestos) {
      const clave = claveCategoria(imp);
      let cat = categorias.get(clave);
      if (!cat) {
        cat = { ...imp, base: 0, tieneBase: false, importe: 0, facturas: new Set() };
        categorias.set(clave, cat);
      }
      cat.importe += centavos(imp.importe);
      if (imp.base !== null) {
        cat.base += centavos(imp.base);
        cat.tieneBase = true;
      }
      cat.facturas.add(f);
    }
  }

  const listaCategorias = Array.from(categorias.values())
    .map((c) => ({ ...c, base: c.base / 100, importe: c.importe / 100, facturas: c.facturas.size }))
    .sort(ordenarCategorias);

  return {
    facturas,
    errores,
    subtotal: subtotal / 100,
    total: total / 100,
    trasladados: trasladados / 100,
    retenidos: retenidos / 100,
    categorias: listaCategorias,
  };
}

async function leerFactura(archivo) {
  const ruta = archivo.webkitRelativePath || archivo.name;
  try {
    const texto = await archivo.text();
    const doc = new DOMParser().parseFromString(texto, 'application/xml');

    if (doc.getElementsByTagName('parsererror').length > 0) {
      return { archivo: ruta, error: 'El XML está mal formado.' };
    }

    const comprobante = doc.documentElement;
    if (!comprobante || comprobante.localName !== 'Comprobante') {
      return { archivo: ruta, error: 'No es un CFDI (no tiene nodo Comprobante).' };
    }

    const emisor = hijo(comprobante, 'Emisor');
    const receptor = hijo(comprobante, 'Receptor');
    const timbre = hijo(comprobante, 'Complemento')
      ? hijo(hijo(comprobante, 'Complemento'), 'TimbreFiscalDigital')
      : null;

    const conceptos = hijos(hijo(comprobante, 'Conceptos'), 'Concepto').map((c) => ({
      claveProdServ: attr(c, 'ClaveProdServ'),
      cantidad: numero(attr(c, 'Cantidad')),
      claveUnidad: attr(c, 'ClaveUnidad'),
      unidad: attr(c, 'Unidad'),
      descripcion: attr(c, 'Descripcion'),
      valorUnitario: numero(attr(c, 'ValorUnitario')),
      importe: numero(attr(c, 'Importe')),
      objetoImp: attr(c, 'ObjetoImp'),
      impuestos: leerImpuestos(hijo(c, 'Impuestos')),
    }));

    // Los impuestos a nivel comprobante son el resumen oficial que cuadra con el Total
    const impuestos = leerImpuestos(hijo(comprobante, 'Impuestos'));
    const sumar = (tipo) =>
      impuestos.filter((i) => i.tipo === tipo).reduce((s, i) => s + centavos(i.importe), 0) / 100;

    return {
      archivo: ruta,
      version: attr(comprobante, 'Version'),
      serie: attr(comprobante, 'Serie'),
      folio: attr(comprobante, 'Folio'),
      fecha: attr(comprobante, 'Fecha'),
      tipo: attr(comprobante, 'TipoDeComprobante'),
      moneda: attr(comprobante, 'Moneda'),
      subtotal: numero(attr(comprobante, 'SubTotal')),
      total: numero(attr(comprobante, 'Total')),
      emisorRfc: emisor ? attr(emisor, 'Rfc') : '',
      emisorNombre: emisor ? attr(emisor, 'Nombre') : '',
      receptorRfc: receptor ? attr(receptor, 'Rfc') : '',
      receptorNombre: receptor ? attr(receptor, 'Nombre') : '',
      uuid: timbre ? attr(timbre, 'UUID') : '',
      impuestos,
      trasladados: sumar('Traslado'),
      retenidos: sumar('Retención'),
      conceptos,
    };
  } catch (e) {
    return { archivo: ruta, error: `No se pudo leer el archivo: ${e.message}` };
  }
}

function leerImpuestos(nodoImpuestos) {
  if (!nodoImpuestos) return [];
  const traslados = hijos(hijo(nodoImpuestos, 'Traslados'), 'Traslado').map((n) => leerImpuesto(n, 'Traslado'));
  const retenciones = hijos(hijo(nodoImpuestos, 'Retenciones'), 'Retencion').map((n) => leerImpuesto(n, 'Retención'));
  return [...traslados, ...retenciones];
}

function leerImpuesto(nodo, tipo) {
  const base = nodo.getAttribute('Base');
  return {
    tipo,
    impuesto: attr(nodo, 'Impuesto'),
    tipoFactor: attr(nodo, 'TipoFactor'),
    tasa: attr(nodo, 'TasaOCuota'),
    base: base === null ? null : numero(base),
    importe: numero(attr(nodo, 'Importe')),
  };
}

function claveCategoria(imp) {
  const tasa = imp.tasa ? numero(imp.tasa).toFixed(6) : '';
  return [imp.tipo, imp.impuesto, imp.tipoFactor, tasa].join('|');
}

function ordenarCategorias(a, b) {
  if (a.tipo !== b.tipo) return a.tipo === 'Traslado' ? -1 : 1;
  if (a.impuesto !== b.impuesto) return a.impuesto.localeCompare(b.impuesto);
  return numero(b.tasa) - numero(a.tasa);
}

function etiquetaImpuesto(imp) {
  const nombre = NOMBRE_IMPUESTO[imp.impuesto] || `Impuesto ${imp.impuesto}`;
  if (imp.tipoFactor === 'Exento') return `${nombre} exento`;
  const accion = imp.tipo === 'Traslado' ? 'trasladado' : 'retenido';
  const tasa = formatearTasa(imp);
  return tasa ? `${nombre} ${accion} ${tasa}` : `${nombre} ${accion}`;
}

function formatearTasa(imp) {
  if (!imp.tasa) return '';
  const n = numero(imp.tasa);
  if (imp.tipoFactor === 'Cuota') return `(cuota ${formatoCantidad.format(n)})`;
  return `${formatoPorcentaje.format(n * 100)}%`;
}

// Navega solo hijos directos por nombre local, para soportar cualquier prefijo (CFDI 3.3 y 4.0)
// y no confundir los impuestos del comprobante con los de cada concepto
function hijos(nodo, nombreLocal) {
  if (!nodo) return [];
  return Array.from(nodo.children).filter((n) => n.localName === nombreLocal);
}

function hijo(nodo, nombreLocal) {
  return hijos(nodo, nombreLocal)[0] || null;
}

function attr(nodo, nombre) {
  return nodo.getAttribute(nombre) || '';
}

function numero(valor) {
  const n = parseFloat(valor);
  return Number.isFinite(n) ? n : 0;
}

// ---------- Presentación ----------

function mostrarReporte(totalArchivos, reporte) {
  const { facturas, errores } = reporte;

  $('totalArchivos').textContent = totalArchivos;
  $('totalFacturas').textContent = facturas.length;
  $('sumaSubtotal').textContent = moneda(reporte.subtotal);
  $('sumaTraslados').textContent = moneda(reporte.trasladados);
  $('sumaRetenciones').textContent = moneda(reporte.retenidos);
  $('sumaTotal').textContent = moneda(reporte.total);
  $('pieSubtotal').textContent = moneda(reporte.subtotal);
  $('pieTraslados').textContent = moneda(reporte.trasladados);
  $('pieRetenciones').textContent = moneda(reporte.retenidos);
  $('pieTotal').textContent = moneda(reporte.total);
  $('pieCatTraslados').textContent = moneda(reporte.trasladados);
  $('pieCatRetenciones').textContent = moneda(reporte.retenidos);

  tablaFacturas.querySelectorAll('tbody.factura').forEach((b) => b.remove());
  const pie = tablaFacturas.querySelector('tfoot');
  facturas.forEach((f, i) => tablaFacturas.insertBefore(crearBloqueFactura(f, i), pie));
  actualizarBotonExpandir();

  mostrarCategorias(reporte.categorias);

  listaErrores.innerHTML = '';
  for (const e of errores) {
    const li = document.createElement('li');
    li.textContent = `${e.archivo}: ${e.error}`;
    listaErrores.appendChild(li);
  }
  bloqueErrores.hidden = errores.length === 0;

  resultado.hidden = false;
}

function crearBloqueFactura(f, indice) {
  const tbody = document.createElement('tbody');
  tbody.className = 'factura';

  const btnToggle = document.createElement('button');
  btnToggle.type = 'button';
  btnToggle.className = 'btn-toggle';
  btnToggle.addEventListener('click', () => {
    expandirFactura(tbody, tbody.classList.contains('contraida'));
    actualizarBotonExpandir();
  });

  const tdToggle = document.createElement('td');
  tdToggle.className = 'col-toggle';
  tdToggle.appendChild(btnToggle);

  const fila = document.createElement('tr');
  fila.className = 'fila-factura';
  fila.append(
    tdToggle,
    celda(indice + 1),
    celda(serieFolio(f)),
    celda(formatearFecha(f.fecha)),
    celdaDoble(f.emisorNombre, f.emisorRfc),
    celdaDoble(f.receptorNombre, f.receptorRfc),
    celda(f.tipo),
    celda(moneda(f.subtotal), 'num'),
    celda(moneda(f.trasladados), 'num'),
    celda(moneda(f.retenidos), f.retenidos > 0 ? 'num retencion' : 'num'),
    celda(moneda(f.total), 'num total')
  );

  const filaDetalle = document.createElement('tr');
  filaDetalle.className = 'fila-detalle';
  const tdDetalle = document.createElement('td');
  tdDetalle.colSpan = COLUMNAS_FACTURA;
  tdDetalle.appendChild(crearDetalle(f));
  filaDetalle.appendChild(tdDetalle);

  tbody.append(fila, filaDetalle);
  expandirFactura(tbody, true);
  return tbody;
}

function crearDetalle(f) {
  const contenedor = document.createElement('div');
  contenedor.className = 'detalle';

  const meta = document.createElement('div');
  meta.className = 'detalle-meta';
  meta.append(
    dato('UUID', f.uuid || '—'),
    dato('Moneda', f.moneda || '—'),
    dato('Archivo', f.archivo)
  );

  const tabla = document.createElement('table');
  tabla.className = 'subtabla';
  tabla.innerHTML = `
    <thead>
      <tr>
        <th>Clave Prod/Serv</th>
        <th>Descripción</th>
        <th class="num">Cantidad</th>
        <th>Unidad</th>
        <th class="num">Valor unitario</th>
        <th class="num">Importe</th>
        <th>Impuestos</th>
      </tr>
    </thead>`;

  const tbody = document.createElement('tbody');
  if (f.conceptos.length === 0) {
    const fila = document.createElement('tr');
    const td = celda('La factura no tiene conceptos.', 'vacio');
    td.colSpan = 7;
    fila.appendChild(td);
    tbody.appendChild(fila);
  }

  for (const c of f.conceptos) {
    const fila = document.createElement('tr');
    fila.append(
      celda(c.claveProdServ),
      celda(c.descripcion),
      celda(formatoCantidad.format(c.cantidad), 'num'),
      celda([c.claveUnidad, c.unidad].filter(Boolean).join(' - ')),
      celda(moneda(c.valorUnitario), 'num'),
      celda(moneda(c.importe), 'num'),
      celdaImpuestos(c)
    );
    tbody.appendChild(fila);
  }
  tabla.appendChild(tbody);

  contenedor.append(meta, tabla);
  return contenedor;
}

function celdaImpuestos(concepto) {
  const td = document.createElement('td');

  if (concepto.impuestos.length === 0) {
    td.className = 'vacio';
    td.textContent = concepto.objetoImp === '01' ? 'No objeto de impuesto' : '—';
    return td;
  }

  const lista = document.createElement('ul');
  lista.className = 'lista-impuestos';
  for (const imp of concepto.impuestos) {
    const li = document.createElement('li');
    if (imp.tipo === 'Retención') li.className = 'retencion';

    const nombre = document.createElement('span');
    nombre.textContent = etiquetaImpuesto(imp);
    const importe = document.createElement('span');
    importe.className = 'importe';
    importe.textContent = imp.tipoFactor === 'Exento' ? '—' : moneda(imp.importe);

    li.append(nombre, importe);
    lista.appendChild(li);
  }
  td.appendChild(lista);
  return td;
}

function mostrarCategorias(categorias) {
  tablaImpuestos.innerHTML = '';

  if (categorias.length === 0) {
    const fila = document.createElement('tr');
    const td = celda('Las facturas no tienen impuestos.', 'vacio');
    td.colSpan = 5;
    fila.appendChild(td);
    tablaImpuestos.appendChild(fila);
    return;
  }

  for (const c of categorias) {
    const esRetencion = c.tipo === 'Retención';
    const fila = document.createElement('tr');
    fila.append(
      celda(etiquetaImpuesto(c)),
      celda(c.tipo),
      celda(c.facturas, 'num'),
      celda(c.tieneBase ? moneda(c.base) : '—', 'num'),
      celda(c.tipoFactor === 'Exento' ? '—' : moneda(c.importe), esRetencion ? 'num retencion' : 'num')
    );
    tablaImpuestos.appendChild(fila);
  }
}

function expandirFactura(tbody, expandir) {
  tbody.classList.toggle('contraida', !expandir);
  const btn = tbody.querySelector('.btn-toggle');
  btn.textContent = expandir ? '▼' : '▶';
  btn.setAttribute('aria-expanded', String(expandir));
  btn.title = expandir ? 'Ocultar conceptos' : 'Mostrar conceptos';
}

function actualizarBotonExpandir() {
  const bloques = Array.from(tablaFacturas.querySelectorAll('tbody.factura'));
  const hayExpandidas = bloques.some((b) => !b.classList.contains('contraida'));
  btnExpandirTodo.textContent = hayExpandidas ? 'Contraer todas' : 'Expandir todas';
}

function serieFolio(f) {
  return [f.serie, f.folio].filter(Boolean).join('-') || '—';
}

function moneda(valor) {
  return formatoMoneda.format(valor);
}

function celda(texto, clase) {
  const td = document.createElement('td');
  td.textContent = texto;
  if (clase) td.className = clase;
  return td;
}

function celdaDoble(principal, secundario) {
  const td = document.createElement('td');
  td.textContent = principal || '—';
  if (secundario) {
    const small = document.createElement('small');
    small.className = 'secundario';
    small.textContent = secundario;
    td.appendChild(small);
  }
  return td;
}

function dato(etiqueta, valor) {
  const span = document.createElement('span');
  const b = document.createElement('b');
  b.textContent = `${etiqueta}: `;
  span.append(b, valor);
  return span;
}

function formatearFecha(fechaIso) {
  if (!fechaIso) return '—';
  const [fecha, hora = ''] = fechaIso.split('T');
  const [a, m, d] = fecha.split('-');
  return `${d}/${m}/${a} ${hora.slice(0, 5)}`.trim();
}

function mostrarEstado(mensaje, esError = false) {
  estado.textContent = mensaje;
  estado.classList.toggle('error', esError);
}
