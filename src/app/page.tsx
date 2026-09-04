"use client";

import { useMemo, useState } from "react";
import { parseCsv } from "./csv";

type ClientRecord = Record<string, string>;

type PrioritizedClient = ClientRecord & {
  name: string;
  seller: string;
  segment: string;
  daysSincePurchase: number | null;
  averageCycle: number | null;
  averageTicket: number | null;
  score: number;
  reason: string;
  signals: string[];
  hasSignal: boolean;
  hasOpportunity: boolean;
};

const fieldNames = {
  clientRm: "CLIENTE_RM",
  clientNectar: "CLIENTE_NECTAR",
  seller: "VENDEDOR_RM",
  revenue: "FATURAMENTO_ACUMULADO",
  ticket: "TICKET_MEDIO_DERIVADO",
  products: "PRODUTOS_COMPRADOS",
  productCount: "QUANTIDADE_PRODUTOS_DIFERENTES",
  frequency: "FREQUENCIA_COMPRA_ANUAL_DERIVADO_pedidos_ano",
  daysSincePurchase: "DIAS_DESDE_ULTIMA_COMPRA_DERIVADO",
  averageCycle: "CICLO_MEDIO_DIAS_DERIVADO",
  cycleReliable: "CICLO_CONFIAVEL_DERIVADO",
  recurringProduct: "PRODUTO_RECORRENTE_DERIVADO",
  lostProduct: "PRODUTO_QUE_DEIXOU_DE_COMPRAR_DERIVADO",
  lastContact: "ULTIMO_CONTATO_NECTAR_INFERIDO",
  segment: "SEGMENTO_NECTAR",
  subsegment: "SUBSEGMENTO_NECTAR",
  stage: "STATUS_ESTAGIO_NECTAR",
} as const;

function parseNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;

  const normalized = value
    .trim()
    .replace(/R\$\s?/gi, "")
    .replace(/\s/g, "");
  const numberValue = normalized.includes(",")
    ? Number(normalized.replace(/\./g, "").replace(",", "."))
    : Number(normalized.replace(/,/g, ""));

  return Number.isFinite(numberValue) ? numberValue : null;
}

function meaningfulText(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  const unknownValues = new Set(["", "NAO IDENTIFICADO", "NAO INFORMADO", "N/A", "NA", "NULL", "-"]);

  return unknownValues.has(normalized) ? null : text;
}

function identifiedProduct(value: string | undefined): string | null {
  const product = meaningfulText(value);
  return product === "0" ? null : product;
 }
  function parseBoolean(value: string | undefined): boolean {
    const normalized = value?.trim().toUpperCase() ?? "";
  return normalized === "TRUE" || normalized === "VERDADEIRO" || normalized === "1" || normalized === "SIM";
}

const PRODUCT_COMPLEMENTS: Record<string, string[]> = {};

function findCrossSellTarget(productsBought: string | null): string | null {
  const products = splitObservedProducts(productsBought)
    .map((product) => product.trim().toLocaleUpperCase());

  for (const product of products) {
    const complements = PRODUCT_COMPLEMENTS[product] ?? [];
    const target = complements.find(
      (candidate) => !products.includes(candidate.toLocaleUpperCase()),
    );
    if (target) return target;
  }

  return null;
}


type LostProductCategory =
  | "Produto real identificado"
  | "Vazio"
  | "NÃO IDENTIFICADO"
  | "NÃO INFORMADO"
  | "N/A"
  | "NULL"
  | "0"
  | "Texto genérico";

type LostProductDiagnostic = {
  topValues: { value: string; count: number }[];
  categories: { category: LostProductCategory; count: number }[];
  realProductExamples: { client: string; value: string }[];
};

function classifyLostProduct(value: string | undefined): LostProductCategory {
  const text = value?.trim() ?? "";
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ");

  if (!normalized) return "Vazio";
  if (normalized === "NAO IDENTIFICADO") return "NÃO IDENTIFICADO";
  if (normalized === "NAO INFORMADO") return "NÃO INFORMADO";
  if (normalized === "N/A" || normalized === "NA") return "N/A";
  if (normalized === "NULL") return "NULL";
  if (normalized === "0") return "0";
  if (/NAO\s+(ESPECIFICADO|IDENTIFICADO)|SEM\s+(DADOS|PRODUTO)|NAO\s+SE\s+APLICA|NENHUM/.test(normalized)) {
    return "Texto genérico";
  }
  return "Produto real identificado";
}

function hasRealLostProduct(value: string | undefined): boolean {
  return classifyLostProduct(value) === "Produto real identificado";
}

function calculateLostProductDiagnostic(
  headers: string[],
  rows: string[][],
): LostProductDiagnostic {
  const records = rows.map((row) =>
    Object.fromEntries(headers.map((header, index) => [header.trim(), row[index] ?? ""])),
  );
  const valueCounts = new Map<string, number>();
  const categoryCounts = new Map<LostProductCategory, number>();

  records.forEach((record) => {
    const value = record[fieldNames.lostProduct]?.trim() ?? "";
    const category = classifyLostProduct(value);
    valueCounts.set(value, (valueCounts.get(value) ?? 0) + 1);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  });

  const realProductExamples = records
    .filter((record) => classifyLostProduct(record[fieldNames.lostProduct]) === "Produto real identificado")
    .slice(0, 10)
    .map((record) => ({
      client: meaningfulText(record[fieldNames.clientNectar])
        || meaningfulText(record[fieldNames.clientRm])
        || "—",
      value: record[fieldNames.lostProduct]?.trim() || "—",
    }));

  const categoryOrder: LostProductCategory[] = [
    "Produto real identificado",
    "Vazio",
    "NÃO IDENTIFICADO",
    "NÃO INFORMADO",
    "N/A",
    "NULL",
    "0",
    "Texto genérico",
  ];

  return {
    topValues: [...valueCounts.entries()]
      .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
      .slice(0, 20)
      .map(([value, count]) => ({ value: value || "(vazio)", count })),
    categories: categoryOrder.map((category) => ({
      category,
      count: categoryCounts.get(category) ?? 0,
    })),
    realProductExamples,
  };
}

function parseDate(value: string | undefined): Date | null {
  if (!value?.trim()) return null;

  const trimmed = value.trim();
  const brazilianDate = trimmed.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  const date = brazilianDate
    ? new Date(
        Number(brazilianDate[3]),
        Number(brazilianDate[2]) - 1,
        Number(brazilianDate[1]),
      )
    : new Date(trimmed);

  return Number.isNaN(date.getTime()) ? null : date;
}

function daysSince(date: Date | null): number | null {
  if (!date) return null;
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.floor((todayStart.getTime() - dateStart.getTime()) / 86400000);
  return days >= 0 ? days : null;
}

function normalize(value: number | null, maximum: number): number {
  if (value === null || maximum <= 0) return 0;
  return Math.min(value / maximum, 1);
}

function formatMetric(value: number | null, suffix = ""): string {
  return value === null ? "—" : `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}${suffix}`;
}

function formatCurrency(value: number | null): string {
  return value === null
    ? "—"
    : value.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

function calculatePriorities(headers: string[], rows: string[][]): PrioritizedClient[] {
  const getValue = (record: ClientRecord, field: string) => record[field] ?? "";
  const records = rows.map((row) =>
    Object.fromEntries(headers.map((header, index) => [header.trim(), row[index] ?? ""])),
  );
  const values = records.map((record) => ({
    record,
    revenue: parseNumber(getValue(record, fieldNames.revenue)),
    ticket: parseNumber(getValue(record, fieldNames.ticket)),
    frequency: parseNumber(getValue(record, fieldNames.frequency)),
    daysSincePurchase: parseNumber(getValue(record, fieldNames.daysSincePurchase)),
    averageCycle: parseNumber(getValue(record, fieldNames.averageCycle)),
    cycleReliable: getValue(record, fieldNames.cycleReliable).trim().toLowerCase() === "true",

    productCount: parseNumber(getValue(record, fieldNames.productCount)),
  }));
  const maximumTicket = Math.max(0, ...values.map(({ ticket }) => ticket ?? 0));
  const maximumRevenue = Math.max(0, ...values.map(({ revenue }) => revenue ?? 0));
  const maximumFrequency = Math.max(0, ...values.map(({ frequency }) => frequency ?? 0));

  return values
    .map(({ record, revenue, ticket, frequency, daysSincePurchase, averageCycle, cycleReliable, productCount }) => {
      
      const name = meaningfulText(getValue(record, fieldNames.clientRm))
        || meaningfulText(getValue(record, fieldNames.clientNectar));
      if (!name) return null;

     const overdueDays = daysSincePurchase !== null && averageCycle !== null && averageCycle > 0 && cycleReliable
  ? Math.max(0, daysSincePurchase - averageCycle)
  : 0; 
      const overdueRatio = averageCycle && overdueDays > 0 ? overdueDays / averageCycle : 0;
      const isOverdue = overdueDays > 0;
      const lostProduct = hasRealLostProduct(getValue(record, fieldNames.lostProduct));
      const hasRelevantHistory = (ticket ?? 0) > 0 || (revenue ?? 0) > 0;
      const crossSellTarget = findCrossSellTarget(getValue(record, fieldNames.products));
const crossSell = crossSellTarget !== null;
      const recentContactDays = daysSince(parseDate(getValue(record, fieldNames.lastContact)));
      const contactDiscount = recentContactDays !== null && recentContactDays <= 14
        ? 0.8
        : recentContactDays !== null && recentContactDays <= 30
          ? 0.9
          : 1;
      const overdueScore = Math.min(overdueRatio / 2, 1) * 35;
      const valueScore = (normalize(ticket, maximumTicket) * 20) + (normalize(revenue, maximumRevenue) * 10);
      const frequencyScore = isOverdue ? normalize(frequency, maximumFrequency) * 15 : 0;
      const opportunityScore = (lostProduct ? 12 : 0) + (crossSell ? 8 : 0);
      const rawScore = (overdueScore + valueScore + frequencyScore + opportunityScore) * contactDiscount;
      const hasSignal = isOverdue || lostProduct || crossSell;
      if (!hasSignal) return null;
      const signals = [
        isOverdue ? "Acima do ciclo de recompra" : null,
        lostProduct ? "Produto deixou de comprar" : null,
        crossSell ? "Oportunidade de venda cruzada" : null,
      ].filter((signal): signal is string => signal !== null);

      const reason = lostProduct
        ? "Produto deixou de comprar"
        : crossSell
          ? "Oportunidade de venda cruzada"
          : isOverdue && frequencyScore >= 7
            ? "Queda de frequência de compra"
            : isOverdue && valueScore >= 15
              ? "Cliente de alto valor atrasado"
              : isOverdue
                ? "Acima do ciclo de recompra"
                : "Cliente de alto valor";

      return {
        ...record,
        name,
        seller: meaningfulText(getValue(record, fieldNames.seller)) ?? "",
        segment: meaningfulText(getValue(record, fieldNames.segment))
          || meaningfulText(getValue(record, fieldNames.subsegment))
          || "",
        daysSincePurchase,
        averageCycle,
        averageTicket: ticket,
        score: Math.max(0, Math.min(100, Math.round(rawScore))),
        reason,
        signals,
        hasSignal: Boolean(hasSignal),
        hasOpportunity: lostProduct || crossSell,
      };
    })
    .filter((client): client is PrioritizedClient => client !== null && client.score > 0)
    .sort((first, second) => second.score - first.score);
}

function countOpportunities(headers: string[], rows: string[][]): number {
  const records = rows.map((row) =>
    Object.fromEntries(headers.map((header, index) => [header.trim(), row[index] ?? ""])),
  );

  return records.filter((record) => {
    const ticket = parseNumber(record[fieldNames.ticket]);
    const revenue = parseNumber(record[fieldNames.revenue]);
    const productCount = parseNumber(record[fieldNames.productCount]);
    const hasRelevantHistory = (ticket ?? 0) > 0 || (revenue ?? 0) > 0;
    const lostProduct = hasRealLostProduct(record[fieldNames.lostProduct]);
    const crossSell = findCrossSellTarget(record[fieldNames.products]) !== null;

    return lostProduct || crossSell;
  }).length;
}

type DiagnosticSummary = {
  total: number;
  validDaysSincePurchase: number;
  validAverageCycle: number;
  overdue: number;
  validPositiveTicket: number;
  validPositiveRevenue: number;
  validPositiveFrequency: number;
  recurringProduct: number;
  validLastContact: number;
  oneProduct: number;
  twoProducts: number;
  multipleSignals: number;
  lostProduct: number;
  crossSell: number;
  crossSellOneProduct: number;
  crossSellTwoProducts: number;
  crossSellThreeProducts: number;
  crossSellFourOrMoreProducts: number;
  crossSellWithRecurringProduct: number;
  crossSellWithoutRecurringProduct: number;
  crossSellWithLostProduct: number;
  crossSellWithNoIdentifiedLostProduct: number;
  crossSellWithNenhumIdentificado: number;
  crossSellWithHistory: number;
  crossSellWithoutHistory: number;
  onlyLostProduct: number;
  onlyCrossSell: number;
  onlyOverdue: number;
  lostAndCrossSell: number;
  lostAndOverdue: number;
  crossSellAndOverdue: number;
  allSignals: number;
  hasOpportunity: number;
  hasSignal: number;
  priority: number;
};

type SignalDiagnostic = {
  record: ClientRecord;
  productCount: number | null;
  productsBought: string | null;
  recurringProduct: string | null;
  lostProductValue: string | null;
  daysSincePurchase: number | null;
  averageCycle: number | null;
  hasRelevantHistory: boolean;
  crossSell: boolean;
  lostProduct: boolean;
  isOverdue: boolean;
  hasOpportunity: boolean;
  hasSignal: boolean;
};

type ProductDistribution = {
  product: string;
  customerCount: number;
  recurringCustomerCount: number;
};

function splitObservedProducts(value: string | null): string[] {
  if (!value) return [];
  return [...new Set(value.split(/[;,|]/).map((product) => product.trim()).filter(Boolean))];
}

function calculateSignalDiagnostics(headers: string[], rows: string[][]): SignalDiagnostic[] {
  const records = rows.map((row) =>
    Object.fromEntries(headers.map((header, index) => [header.trim(), row[index] ?? ""])),
  );

  return records.map((record) => {
    const ticket = parseNumber(record[fieldNames.ticket]);
    const revenue = parseNumber(record[fieldNames.revenue]);
    const productCount = parseNumber(record[fieldNames.productCount]);
    const daysSincePurchase = parseNumber(record[fieldNames.daysSincePurchase]);
    const averageCycle = parseNumber(record[fieldNames.averageCycle]);
const cycleReliable = record[fieldNames.cycleReliable].trim().toLowerCase() === "true";
const overdueDays = daysSincePurchase !== null && averageCycle !== null && averageCycle > 0 && cycleReliable
  ? Math.max(0, daysSincePurchase - averageCycle)
  : 0;
    const isOverdue = overdueDays > 0;
    const lostProduct = hasRealLostProduct(record[fieldNames.lostProduct]);
    const hasRelevantHistory = (ticket ?? 0) > 0 || (revenue ?? 0) > 0;
    const crossSell = findCrossSellTarget(record[fieldNames.products]) !== null;

    return {
      record,
      productCount,
      productsBought: meaningfulText(record[fieldNames.products]),
      recurringProduct: identifiedProduct(record[fieldNames.recurringProduct]),
      lostProductValue: identifiedProduct(record[fieldNames.lostProduct]),
      daysSincePurchase,
      averageCycle,
      hasRelevantHistory,
      crossSell,
      lostProduct,
      isOverdue,
      hasOpportunity: lostProduct || crossSell,
      hasSignal: isOverdue || lostProduct || crossSell,
    };
  });
}

function calculateCrossSellProductDistribution(
  signalDiagnostics: SignalDiagnostic[],
): ProductDistribution[] {
  const distribution = new Map<string, ProductDistribution>();

  signalDiagnostics
    .filter((signals) => signals.crossSell)
    .forEach((signals) => {
      const recurringProduct = signals.recurringProduct?.trim().toLocaleUpperCase();
      splitObservedProducts(signals.productsBought).forEach((product) => {
        const key = product.toLocaleUpperCase();
        const current = distribution.get(key) ?? {
          product,
          customerCount: 0,
          recurringCustomerCount: 0,
        };
        current.customerCount += 1;
        if (recurringProduct === key) current.recurringCustomerCount += 1;
        distribution.set(key, current);
      });
    });

  return [...distribution.values()].sort(
    (first, second) => second.customerCount - first.customerCount
      || first.product.localeCompare(second.product),
  );
}

function calculateDiagnostic(
  headers: string[],
  rows: string[][],
  priorities: PrioritizedClient[],
): DiagnosticSummary {
  const signalDiagnostics = calculateSignalDiagnostics(headers, rows);
  const records = signalDiagnostics.map(({ record }) => record);
  const getNumber = (record: ClientRecord, field: string) => parseNumber(record[field]);
  const count = (predicate: (record: ClientRecord) => boolean) => records.filter(predicate).length;
  const countSignals = (predicate: (signals: SignalDiagnostic) => boolean) => signalDiagnostics.filter(predicate).length;

  return {
    total: records.length,
    validDaysSincePurchase: count((record) => getNumber(record, fieldNames.daysSincePurchase) !== null),
    validAverageCycle: count((record) => getNumber(record, fieldNames.averageCycle) !== null),
    validPositiveTicket: count((record) => (getNumber(record, fieldNames.ticket) ?? 0) > 0),
    validPositiveRevenue: count((record) => (getNumber(record, fieldNames.revenue) ?? 0) > 0),
    validPositiveFrequency: count((record) => (getNumber(record, fieldNames.frequency) ?? 0) > 0),
    recurringProduct: count((record) => identifiedProduct(record[fieldNames.recurringProduct]) !== null),
    validLastContact: count((record) => parseDate(record[fieldNames.lastContact]) !== null),
    oneProduct: count((record) => getNumber(record, fieldNames.productCount) === 1),
    twoProducts: count((record) => getNumber(record, fieldNames.productCount) === 2),
    hasSignal: countSignals((signals) => signals.hasSignal),
    hasOpportunity: countSignals((signals) => signals.hasOpportunity),
    multipleSignals: countSignals((signals) => [
      signals.lostProduct,
      signals.crossSell,
      signals.isOverdue,
    ].filter(Boolean).length > 1),
    lostProduct: countSignals((signals) => signals.lostProduct),
    crossSell: countSignals((signals) => signals.crossSell),
    crossSellOneProduct: countSignals((signals) => signals.crossSell && signals.productCount === 1),
    crossSellTwoProducts: countSignals((signals) => signals.crossSell && signals.productCount === 2),
    crossSellThreeProducts: countSignals((signals) => signals.crossSell && signals.productCount === 3),
    crossSellFourOrMoreProducts: countSignals((signals) => signals.crossSell && signals.productCount !== null && signals.productCount >= 4),
    crossSellWithRecurringProduct: countSignals((signals) => signals.crossSell && signals.recurringProduct !== null),
    crossSellWithoutRecurringProduct: countSignals((signals) => signals.crossSell && signals.recurringProduct === null),
    crossSellWithLostProduct: countSignals((signals) => signals.crossSell && signals.lostProduct),
    crossSellWithNoIdentifiedLostProduct: countSignals((signals) => signals.crossSell && !signals.lostProduct),
    crossSellWithNenhumIdentificado: countSignals((signals) => {
      const value = signals.record[fieldNames.lostProduct]
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toUpperCase();
      return signals.crossSell && value === "NENHUM_IDENTIFICADO";
    }),
    crossSellWithHistory: countSignals((signals) => signals.crossSell && signals.hasRelevantHistory),
    crossSellWithoutHistory: countSignals((signals) => signals.crossSell && !signals.hasRelevantHistory),
    overdue: countSignals((signals) => signals.isOverdue),
    onlyLostProduct: countSignals((signals) => signals.lostProduct && !signals.crossSell && !signals.isOverdue),
    onlyCrossSell: countSignals((signals) => signals.crossSell && !signals.lostProduct && !signals.isOverdue),
    onlyOverdue: countSignals((signals) => signals.isOverdue && !signals.lostProduct && !signals.crossSell),
    lostAndCrossSell: countSignals((signals) => signals.lostProduct && signals.crossSell && !signals.isOverdue),
    lostAndOverdue: countSignals((signals) => signals.lostProduct && signals.isOverdue && !signals.crossSell),
    crossSellAndOverdue: countSignals((signals) => signals.crossSell && signals.isOverdue && !signals.lostProduct),
    allSignals: countSignals((signals) => signals.lostProduct && signals.crossSell && signals.isOverdue),
    priority: priorities.length,
  };
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Home() {
  const [fileName, setFileName] = useState("");
  const [fileSize, setFileSize] = useState("");
  const [recordCount, setRecordCount] = useState<number | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<string[][]>([]);
  const [importedRows, setImportedRows] = useState<string[][]>([]);
  const [importError, setImportError] = useState("");
  const priorities = useMemo(
    () => calculatePriorities(csvHeaders, importedRows),
    [csvHeaders, importedRows],
  );
  const topPriorities = priorities.slice(0, 10);
  const diagnostic = useMemo(
    () => calculateDiagnostic(csvHeaders, importedRows, priorities),
    [csvHeaders, importedRows, priorities],
  );
  const lostProductDiagnostic = useMemo(
    () => calculateLostProductDiagnostic(csvHeaders, importedRows),
    [csvHeaders, importedRows],
  );
  const signalDiagnostics = useMemo(
    () => calculateSignalDiagnostics(csvHeaders, importedRows),
    [csvHeaders, importedRows],
  );
  const crossSellExamples = signalDiagnostics.filter((signals) => signals.crossSell).slice(0, 20);
  const crossSellProductDistribution = useMemo(
    () => calculateCrossSellProductDistribution(signalDiagnostics),
    [signalDiagnostics],
  );
  const identifiedPotential = priorities.reduce(
    (total, client) => total + (client.averageTicket ?? 0),
    0,
  );
  const opportunityCount = countOpportunities(csvHeaders, importedRows);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) return;

    setFileName(file.name);
    setFileSize(formatFileSize(file.size));
    setRecordCount(null);
    setCsvHeaders([]);
    setPreviewRows([]);
    setImportedRows([]);
    setImportError("");

    if (!file.name.toLowerCase().endsWith(".csv")) {
      setImportError("Nesta etapa, selecione um arquivo CSV.");
      return;
    }

    try {
      const content = await file.text();
      const { headers, records } = parseCsv(content);
      setCsvHeaders(headers);
      setPreviewRows(records.slice(0, 5));
      setImportedRows(records);
      setRecordCount(records.length);
    } catch {
      setImportError("Não foi possível ler este arquivo CSV.");
    }
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 font-sans text-zinc-900">
      <div className="mx-auto max-w-7xl">

        {/* CABEÇALHO */}
        <header className="mb-8 flex items-start justify-between">
          <div>
            <p className="mb-2 text-sm font-medium text-blue-600">
              TetraMind
            </p>

            <h1 className="text-4xl font-bold tracking-tight">
              Cockpit Comercial
            </h1>

            <p className="mt-2 text-lg text-zinc-500">
              Transforme os dados do CRM em ações comerciais.
            </p>
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white px-6 py-4 shadow-sm">
            <p className="text-sm text-zinc-500">Status</p>
            <p className="mt-1 font-semibold text-emerald-600">
              Sistema ativo
            </p>
          </div>
        </header>

        {/* INDICADORES */}
        <section className="mb-8 grid gap-5 md:grid-cols-4">

          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-zinc-500">Clientes analisados</p>
            <p className="mt-3 text-4xl font-bold">
              {recordCount === null ? "—" : recordCount.toLocaleString("pt-BR")}
            </p>
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-zinc-500">Prioridades de hoje</p>
            <p className="mt-3 text-4xl font-bold">
              {recordCount === null ? "—" : priorities.length.toLocaleString("pt-BR")}
            </p>
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-zinc-500">Potencial identificado</p>
            <p className="mt-3 text-4xl font-bold">
              {recordCount === null ? "—" : formatCurrency(identifiedPotential)}
            </p>
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <p className="text-sm text-zinc-500">Oportunidades</p>
            <p className="mt-3 text-4xl font-bold">
              {recordCount === null ? "—" : opportunityCount.toLocaleString("pt-BR")}
            </p>
          </div>

        </section>

        {/* IMPORTAÇÃO */}
        <section className="mb-8 rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">

          <div className="mb-6">
            <h2 className="text-2xl font-bold">
              Importar dados do CRM
            </h2>

            <p className="mt-2 text-zinc-500">
              Envie a planilha exportada do Nectar para iniciar a análise
              comercial.
            </p>
          </div>

          <label
            htmlFor="crm-file"
            className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-zinc-300 bg-zinc-50 px-6 py-12 text-center transition hover:border-blue-500 hover:bg-blue-50"
          >
            <div className="mb-4 text-4xl">
              📊
            </div>

            <p className="text-lg font-semibold">
              Selecionar arquivo do CRM
            </p>

            <p className="mt-2 text-sm text-zinc-500">
              CSV (.csv)
            </p>

            <span className="mt-6 rounded-xl bg-zinc-900 px-6 py-3 text-sm font-semibold text-white">
              Selecionar arquivo
            </span>

            <input
              id="crm-file"
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileChange}
              className="hidden"
            />
          </label>

          {fileName && (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm text-emerald-700">Arquivo selecionado</p>

              <p className="mt-1 font-semibold text-emerald-900">
                {fileName}
              </p>

              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-emerald-800">
                <span>Tamanho: {fileSize}</span>
                   <span>
                  Registros encontrados: {recordCount === null ? "lendo..." : recordCount.toLocaleString("pt-BR")}
                </span>
              </div>
            </div>
          )}

          {recordCount !== null && (
            <section className="mt-6 border-t border-zinc-200 pt-6">
              <h3 className="text-xl font-bold">Prévia dos dados importados</h3>

              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-zinc-600">
                <span>
                  Total de registros encontrados: {recordCount.toLocaleString("pt-BR")}
                </span>
                <span>
                  Colunas encontradas: {csvHeaders.length.toLocaleString("pt-BR")}
                </span>
              </div>

              <div className="mt-4">
                <p className="text-sm font-semibold text-zinc-700">Nomes das colunas</p>
                {csvHeaders.length > 0 ? (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {csvHeaders.map((header, index) => (
                      <li
                        key={`${header}-${index}`}
                        className="rounded-md bg-zinc-100 px-3 py-1.5 text-sm text-zinc-700"
                      >
                        {header || `Coluna ${index + 1}`}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-zinc-500">Nenhuma coluna encontrada.</p>
                )}
              </div>

              {csvHeaders.length > 0 && previewRows.length > 0 && (
                <div className="mt-5 overflow-x-auto rounded-lg border border-zinc-200">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-zinc-50 text-zinc-700">
                      <tr>
                        {csvHeaders.map((header, index) => (
                          <th key={`${header}-${index}`} className="whitespace-nowrap px-4 py-3 font-semibold">
                            {header || `Coluna ${index + 1}`}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-200">
                      {previewRows.map((row, rowIndex) => (
                        <tr key={rowIndex} className="text-zinc-600">
                          {csvHeaders.map((_, columnIndex) => (
                            <td key={columnIndex} className="whitespace-nowrap px-4 py-3">
                              {row[columnIndex] || "-"}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {importError && (
            <p className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {importError}
            </p>
          )}

        </section>

        {recordCount !== null && (
          <section className="mb-8 rounded-2xl border border-amber-200 bg-amber-50/50 shadow-sm">
            <div className="border-b border-amber-200 px-8 py-6">
              <h2 className="text-2xl font-bold">Diagnóstico da classificação</h2>
              <p className="mt-2 text-zinc-600">
                Distribuição dos dados e dos sinais usados pela classificação atual.
              </p>
            </div>

            <div className="grid gap-4 p-8 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ["Total de registros importados", diagnostic.total],
                ["Dias desde a última compra válidos", diagnostic.validDaysSincePurchase],
                ["Ciclos médios válidos", diagnostic.validAverageCycle],
                ["Clientes atrasados", diagnostic.overdue],
                ["Tickets válidos e maiores que zero", diagnostic.validPositiveTicket],
                ["Faturamentos válidos e maiores que zero", diagnostic.validPositiveRevenue],
                ["Frequências válidas e maiores que zero", diagnostic.validPositiveFrequency],
                ["Produto recorrente identificado", diagnostic.recurringProduct],
                ["Produto deixado de comprar identificado", diagnostic.lostProduct],
                ["Último contato com data válida", diagnostic.validLastContact],
                ["Clientes com 1 produto", diagnostic.oneProduct],
                ["Clientes com 2 produtos", diagnostic.twoProducts],
                ["Classificados como hasSignal", diagnostic.hasSignal],
                ["Classificados como hasOpportunity", diagnostic.hasOpportunity],
                ["Mais de um sinal comercial", diagnostic.multipleSignals],
              ].map(([label, value]) => (
                <div key={label as string} className="rounded-xl border border-amber-200 bg-white p-4">
                  <p className="text-sm text-zinc-500">{label}</p>
                  <p className="mt-2 text-2xl font-bold">{(value as number).toLocaleString("pt-BR")}</p>
                </div>
              ))}
            </div>

            <div className="border-t border-amber-200 px-8 py-6">
              <h3 className="text-xl font-bold">Origem dos sinais atuais</h3>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ["lostProduct = true", diagnostic.lostProduct],
                  ["crossSell = true", diagnostic.crossSell],
                  ["isOverdue = true", diagnostic.overdue],
                  ["Somente lostProduct", diagnostic.onlyLostProduct],
                  ["Somente crossSell", diagnostic.onlyCrossSell],
                  ["Somente isOverdue", diagnostic.onlyOverdue],
                  ["lostProduct + crossSell", diagnostic.lostAndCrossSell],
                  ["lostProduct + isOverdue", diagnostic.lostAndOverdue],
                  ["crossSell + isOverdue", diagnostic.crossSellAndOverdue],
                  ["Os três sinais", diagnostic.allSignals],
                  ["hasOpportunity = true", diagnostic.hasOpportunity],
                  ["hasSignal = true", diagnostic.hasSignal],
                  ["Classificados como prioridade", diagnostic.priority],
                ].map(([label, value]) => (
                  <div key={label as string} className="rounded-xl border border-amber-200 bg-white p-4">
                    <p className="text-sm text-zinc-500">{label}</p>
                    <p className="mt-2 text-2xl font-bold">{(value as number).toLocaleString("pt-BR")}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="border-t border-amber-200 px-8 py-6">
              <h3 className="text-xl font-bold">Detalhamento de crossSell</h3>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ["crossSell = true", diagnostic.crossSell],
                  ["crossSell com 1 produto", diagnostic.crossSellOneProduct],
                  ["crossSell com 2 produtos", diagnostic.crossSellTwoProducts],
                  ["crossSell com 3 produtos", diagnostic.crossSellThreeProducts],
                  ["crossSell com 4 ou mais produtos", diagnostic.crossSellFourOrMoreProducts],
                  ["crossSell com produto recorrente", diagnostic.crossSellWithRecurringProduct],
                  ["crossSell sem produto recorrente identificado", diagnostic.crossSellWithoutRecurringProduct],
                  ["crossSell com produto deixado de comprar real", diagnostic.crossSellWithLostProduct],
                  ["crossSell com NENHUM_IDENTIFICADO", diagnostic.crossSellWithNenhumIdentificado],
                  ["crossSell com hasRelevantHistory = true", diagnostic.crossSellWithHistory],
                  ["crossSell com hasRelevantHistory = false", diagnostic.crossSellWithoutHistory],
                ].map(([label, value]) => (
                  <div key={label as string} className="rounded-xl border border-amber-200 bg-white p-4">
                    <p className="text-sm text-zinc-500">{label}</p>
                    <p className="mt-2 text-2xl font-bold">{(value as number).toLocaleString("pt-BR")}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="border-t border-amber-200 px-8 py-6">
              <h3 className="text-xl font-bold">Exemplos atuais de crossSell</h3>
              {crossSellExamples.length === 0 ? (
                <p className="mt-4 text-sm text-zinc-500">Nenhum cliente com crossSell = true.</p>
              ) : (
                <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-zinc-50 text-zinc-700">
                      <tr>
                        {[
                          "Cliente",
                          "Qtd. produtos",
                          "Produtos comprados",
                          "Produto recorrente",
                          "Produto deixou de comprar",
                          "Dias desde última compra",
                          "Ciclo médio",
                          "hasRelevantHistory",
                          "crossSell",
                          "lostProduct",
                          "isOverdue",
                        ].map((header) => (
                          <th key={header} className="whitespace-nowrap px-4 py-3 font-semibold">{header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-200">
                      {crossSellExamples.map((signals, index) => (
                        <tr key={`${signals.record[fieldNames.clientNectar]}-${index}`} className="text-zinc-600">
                          <td className="whitespace-nowrap px-4 py-3 font-medium text-zinc-900">
                            {meaningfulText(signals.record[fieldNames.clientNectar])
                              || meaningfulText(signals.record[fieldNames.clientRm])
                              || "—"}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">{formatMetric(signals.productCount)}</td>
                          <td className="max-w-sm px-4 py-3">{signals.productsBought ?? "—"}</td>
                          <td className="max-w-sm px-4 py-3">{signals.recurringProduct ?? "—"}</td>
                          <td className="max-w-sm px-4 py-3">{signals.lostProductValue ?? "—"}</td>
                          <td className="whitespace-nowrap px-4 py-3">{formatMetric(signals.daysSincePurchase, " dias")}</td>
                          <td className="whitespace-nowrap px-4 py-3">{formatMetric(signals.averageCycle, " dias")}</td>
                          <td className="whitespace-nowrap px-4 py-3">{signals.hasRelevantHistory ? "true" : "false"}</td>
                          <td className="whitespace-nowrap px-4 py-3">{signals.crossSell ? "true" : "false"}</td>
                          <td className="whitespace-nowrap px-4 py-3">{signals.lostProduct ? "true" : "false"}</td>
                          <td className="whitespace-nowrap px-4 py-3">{signals.isOverdue ? "true" : "false"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="border-t border-amber-200 px-8 py-6">
              <h3 className="text-xl font-bold">Distribuição do produto deixado de comprar</h3>
              <p className="mt-2 text-sm text-zinc-600">
                Os valores abaixo são os textos encontrados no campo importado, agrupados por ocorrência.
              </p>

              <div className="mt-4 grid gap-6 lg:grid-cols-2">
                <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-zinc-50 text-zinc-700">
                      <tr>
                        <th className="px-4 py-3 font-semibold">Valor encontrado</th>
                        <th className="px-4 py-3 font-semibold">Registros</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-200">
                      {lostProductDiagnostic.topValues.map(({ value, count }) => (
                        <tr key={value} className="text-zinc-600">
                          <td className="max-w-md px-4 py-3">{value}</td>
                          <td className="px-4 py-3">{count.toLocaleString("pt-BR")}</td>
                        </tr>
                      ))}
                    </tbody>

                    <div className="border-t border-amber-200 px-8 py-6">
                      <h3 className="text-xl font-bold">Distribuição dos produtos comprados por clientes crossSell</h3>
                      {crossSellProductDistribution.length === 0 ? (
                        <p className="mt-4 text-sm text-zinc-500">Nenhum produto observado nos clientes crossSell.</p>
                      ) : (
                        <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
                          <table className="min-w-full text-left text-sm">
                            <thead className="bg-zinc-50 text-zinc-700">
                              <tr>
                                <th className="px-4 py-3 font-semibold">Produto observado</th>
                                <th className="px-4 py-3 font-semibold">Clientes que compraram</th>
                                <th className="px-4 py-3 font-semibold">Clientes com produto recorrente</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-200">
                              {crossSellProductDistribution.map(({ product, customerCount, recurringCustomerCount }) => (
                                <tr key={product} className="text-zinc-600">
                                  <td className="px-4 py-3 font-medium text-zinc-900">{product}</td>
                                  <td className="px-4 py-3">{customerCount.toLocaleString("pt-BR")}</td>
                                  <td className="px-4 py-3">{recurringCustomerCount.toLocaleString("pt-BR")}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </table>
                </div>

                <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-zinc-50 text-zinc-700">
                      <tr>
                        <th className="px-4 py-3 font-semibold">Categoria</th>
                        <th className="px-4 py-3 font-semibold">Registros</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-200">
                      {lostProductDiagnostic.categories.map(({ category, count }) => (
                        <tr key={category} className="text-zinc-600">
                          <td className="px-4 py-3">{category}</td>
                          <td className="px-4 py-3">{count.toLocaleString("pt-BR")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <h3 className="mt-6 text-xl font-bold">Exemplos de valores considerados produto real</h3>
              {lostProductDiagnostic.realProductExamples.length === 0 ? (
                <p className="mt-4 text-sm text-zinc-500">Nenhum valor foi identificado como produto real.</p>
              ) : (
                <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-zinc-50 text-zinc-700">
                      <tr>
                        <th className="px-4 py-3 font-semibold">Cliente</th>
                        <th className="px-4 py-3 font-semibold">Valor do campo</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-200">
                      {lostProductDiagnostic.realProductExamples.map(({ client, value }) => (
                        <tr key={`${client}-${value}`} className="text-zinc-600">
                          <td className="px-4 py-3 font-medium text-zinc-900">{client}</td>
                          <td className="px-4 py-3">{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="border-t border-amber-200 px-8 py-6">
              <h3 className="text-xl font-bold">Exemplos classificados como prioridade</h3>
              {topPriorities.length === 0 ? (
                <p className="mt-4 text-sm text-zinc-500">Nenhum exemplo disponível.</p>
              ) : (
                <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-200 bg-white">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-zinc-50 text-zinc-700">
                      <tr>
                        {[
                          "Cliente",
                          "Dias desde última compra",
                          "Ciclo médio",
                          "Ticket médio",
                          "Produto recorrente",
                          "Produto deixou de comprar",
                          "Qtd. produtos",
                          "Score atual",
                          "Sinais",
                        ].map((header) => (
                          <th key={header} className="whitespace-nowrap px-4 py-3 font-semibold">{header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-200">
                      {topPriorities.map((client) => (
                        <tr key={`${client.name}-${client.seller}`} className="text-zinc-600">
                          <td className="whitespace-nowrap px-4 py-3 font-medium text-zinc-900">{client.name}</td>
                          <td className="whitespace-nowrap px-4 py-3">{formatMetric(client.daysSincePurchase, " dias")}</td>
                          <td className="whitespace-nowrap px-4 py-3">{formatMetric(client.averageCycle, " dias")}</td>
                          <td className="whitespace-nowrap px-4 py-3">{formatCurrency(client.averageTicket)}</td>
                          <td className="whitespace-nowrap px-4 py-3">{identifiedProduct(client[fieldNames.recurringProduct]) ?? "—"}</td>
                          <td className="whitespace-nowrap px-4 py-3">{identifiedProduct(client[fieldNames.lostProduct]) ?? "—"}</td>
                          <td className="whitespace-nowrap px-4 py-3">{formatMetric(parseNumber(client[fieldNames.productCount]))}</td>
                          <td className="whitespace-nowrap px-4 py-3 font-semibold text-blue-600">{client.score}</td>
                          <td className="px-4 py-3">{client.signals.join(", ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        )}

        {/* PRIORIDADE */}
        <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">

          <div className="border-b border-zinc-200 px-8 py-6">
            <h2 className="text-2xl font-bold">
              Prioridade de hoje
            </h2>

            <p className="mt-2 text-zinc-500">
              Clientes que merecem atenção comercial primeiro.
            </p>
          </div>

          {recordCount === null ? (
            <div className="px-8 py-10 text-center text-zinc-500">
              Importe um CSV para calcular as prioridades comerciais.
            </div>
          ) : topPriorities.length === 0 ? (
            <div className="px-8 py-10 text-center text-zinc-500">
              Não há dados suficientes para identificar prioridades comerciais.
            </div>
          ) : (
            <div className="divide-y divide-zinc-200">
              {topPriorities.map((client) => (
                <div key={`${client.name}-${client.seller}`} className="grid gap-6 px-8 py-7 md:grid-cols-5 md:items-center">
                  <div>
                    <p className="font-bold">{client.name}</p>
                    <p className="mt-1 text-sm text-zinc-500">{client.seller || "—"}</p>
                    <p className="mt-1 text-sm text-zinc-500">{client.segment || "—"}</p>
                  </div>
                  <div>
                    <p className="text-sm text-zinc-500">Dias desde a última compra</p>
                    <p className="mt-1 font-medium">{formatMetric(client.daysSincePurchase, " dias")}</p>
                  </div>
                  <div>
                    <p className="text-sm text-zinc-500">Ciclo médio de compra</p>
                    <p className="mt-1 font-medium">{formatMetric(client.averageCycle, " dias")}</p>
                  </div>
                  <div>
                    <p className="text-sm text-zinc-500">Ticket médio</p>
                    <p className="mt-1 font-medium">{formatCurrency(client.averageTicket)}</p>
                  </div>
                  <div className="text-left md:text-right">
                    <span className="inline-block rounded-full bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-600">
                      Score Comercial {client.score}
                    </span>
                    <p className="mt-2 text-sm text-zinc-500">{client.reason}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

        </section>

      </div>
    </main>
  );
}
