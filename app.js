'use strict';

const btnSeleccionar = document.getElementById('btnSeleccionar');
const inputCarpeta = document.getElementById('inputCarpeta');
const estado = document.getElementById('estado');
const resultado = document.getElementById('resultado');
const totalArchivos = document.getElementById('totalArchivos');
const totalFacturas = document.getElementById('totalFacturas');
const sumaSubtotal = document.getElementById('sumaSubtotal');
const sumaTotal = document.getElementById('sumaTotal');
const tablaFacturas = document.getElementById('tablaFacturas');
const tablaConceptos = document.getElementById('tablaConceptos');
const pieSubtotal = document.getElementById('pieSubtotal');
const pieTotal = document.getElementById('pieTotal');
const pieImporte = document.getElementById('pieImporte');
const bloqueErrores = document.getElementById('bloqueErrores');
const listaErrores = document.getElementById('listaErrores');

const formatoMoneda = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const formatoCantidad = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 6 });

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

function filtrarXml(archivos) {
  return archivos.filter((f) => f.name.toLowerCase().endsWith('.xml'));
}

async function procesarXmls(xmls) {
  const resultados = await Promise.all(xmls.map(leerFactura));

  const facturas = [];
  const errores = [];
  for (const r of resultados) {
    if (r.error) errores.push(r);
    else facturas.push(r);
  }

  facturas.sort((a, b) => a.fecha.localeCompare(b.fecha));

  // Se suma en centavos (enteros) para evitar errores de punto flotante
  const centavos = (n) => Math.round(n * 100);
  const subtotal = facturas.reduce((s, f) => s + centavos(f.subtotal), 0) / 100;
  const total = facturas.reduce((s, f) => s + centavos(f.total), 0) / 100;
  const importeConceptos = facturas.reduce(
    (s, f) => s + f.conceptos.reduce((sc, c) => sc + centavos(c.importe), 0),
    0
  ) / 100;

  return { facturas, errores, subtotal, total, importeConceptos };
}

async function leerFactura(archivo) {
  const ruta = archivo.webkitRelativePath || archivo.name;
  try {
    const texto = await archivo.text();
    const doc = new DOMParser().parseFromString(texto, 'application/xml');

    if (doc.getElementsByTagName('parsererror').length > 0) {
      return { archivo: ruta, error: 'El XML está mal formado.' };
    }

    const comprobante = primerNodo(doc, 'Comprobante');
    if (!comprobante) {
      return { archivo: ruta, error: 'No es un CFDI (no tiene nodo Comprobante).' };
    }

    const emisor = primerNodo(comprobante, 'Emisor');
    const receptor = primerNodo(comprobante, 'Receptor');
    const timbre = primerNodo(comprobante, 'TimbreFiscalDigital');

    const conceptos = nodos(comprobante, 'Concepto').map((c) => ({
      claveProdServ: attr(c, 'ClaveProdServ'),
      cantidad: numero(attr(c, 'Cantidad')),
      claveUnidad: attr(c, 'ClaveUnidad'),
      unidad: attr(c, 'Unidad'),
      descripcion: attr(c, 'Descripcion'),
      valorUnitario: numero(attr(c, 'ValorUnitario')),
      importe: numero(attr(c, 'Importe')),
    }));

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
      conceptos,
    };
  } catch (e) {
    return { archivo: ruta, error: `No se pudo leer el archivo: ${e.message}` };
  }
}

// Busca por nombre local para soportar cualquier prefijo/namespace (CFDI 3.3 y 4.0)
function nodos(raiz, nombreLocal) {
  return Array.from(raiz.getElementsByTagNameNS('*', nombreLocal));
}

function primerNodo(raiz, nombreLocal) {
  return raiz.getElementsByTagNameNS('*', nombreLocal)[0] || null;
}

function attr(nodo, nombre) {
  return nodo.getAttribute(nombre) || '';
}

function numero(valor) {
  const n = parseFloat(valor);
  return Number.isFinite(n) ? n : 0;
}

function mostrarReporte(total, reporte) {
  const { facturas, errores } = reporte;

  totalArchivos.textContent = total;
  totalFacturas.textContent = facturas.length;
  sumaSubtotal.textContent = formatoMoneda.format(reporte.subtotal);
  sumaTotal.textContent = formatoMoneda.format(reporte.total);
  pieSubtotal.textContent = formatoMoneda.format(reporte.subtotal);
  pieTotal.textContent = formatoMoneda.format(reporte.total);
  pieImporte.textContent = formatoMoneda.format(reporte.importeConceptos);

  tablaFacturas.innerHTML = '';
  tablaConceptos.innerHTML = '';
  listaErrores.innerHTML = '';

  let numConcepto = 0;
  facturas.forEach((f, i) => {
    const serieFolio = [f.serie, f.folio].filter(Boolean).join('-') || '—';

    const fila = document.createElement('tr');
    fila.title = f.archivo;
    fila.append(
      celda(i + 1),
      celda(serieFolio),
      celda(formatearFecha(f.fecha)),
      celdaDoble(f.emisorNombre, f.emisorRfc),
      celdaDoble(f.receptorNombre, f.receptorRfc),
      celda(f.tipo),
      celda(f.uuid, 'uuid'),
      celda(formatoMoneda.format(f.subtotal), 'num'),
      celda(formatoMoneda.format(f.total), 'num')
    );
    tablaFacturas.appendChild(fila);

    for (const c of f.conceptos) {
      const filaC = document.createElement('tr');
      filaC.append(
        celda(++numConcepto),
        celda(serieFolio),
        celda(c.claveProdServ),
        celda(c.descripcion),
        celda(formatoCantidad.format(c.cantidad), 'num'),
        celda([c.claveUnidad, c.unidad].filter(Boolean).join(' - ')),
        celda(formatoMoneda.format(c.valorUnitario), 'num'),
        celda(formatoMoneda.format(c.importe), 'num')
      );
      tablaConceptos.appendChild(filaC);
    }
  });

  for (const e of errores) {
    const li = document.createElement('li');
    li.textContent = `${e.archivo}: ${e.error}`;
    listaErrores.appendChild(li);
  }
  bloqueErrores.hidden = errores.length === 0;

  resultado.hidden = false;
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
