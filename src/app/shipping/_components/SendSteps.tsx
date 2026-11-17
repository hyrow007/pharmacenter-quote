"use client";

import type { Lang } from "@/lib/i18n/dict";

// What to print and how to send it -- shown under a freshly made label and
// behind "How to send" in the log. Plain steps, both languages. FedEx's own
// wording on international label pages ("CONSIGNEE COPY - PLEASE PLACE IN
// FRONT OF POUCH", "FEDEX AWB COPY - PLEASE PLACE BEHIND CONSIGNEE COPY") is
// what the pouch steps follow; FedEx asks for the commercial invoice as an
// original plus two copies.

type Props = {
  lang: Lang;
  international: boolean;
  signature?: boolean;
  recipientPays?: boolean;
  appInvoice?: boolean; // FedEx sent no invoice: the app's one is used
  service?: string | null;
};

export default function SendSteps({ lang, international, signature, recipientPays, appInvoice, service }: Props) {
  const es = lang === "es";
  const ground = /GROUND|HOME_DELIVERY/.test(service ?? "");
  const steps: string[] = [];
  if (!international) {
    steps.push(
      es
        ? "Imprima la etiqueta: 1 hoja carta, tamaño real (100 %), no \"ajustar a la página\"."
        : "Print the label: 1 letter page, actual size (100%), not \"fit to page\".",
      es
        ? "Doble la hoja por la línea y péguela en la cara más grande de la caja, plana, sin cubrir el código de barras con cinta. Quite o tache cualquier etiqueta o código de barras viejo."
        : "Fold it on the line and tape it flat on the largest side of the box, without taping over the barcode. Remove or black out any old labels and barcodes.",
    );
  } else {
    steps.push(
      es
        ? "Imprima el PDF de la etiqueta completo (4 hojas), tamaño real (100 %)."
        : "Print the whole label PDF (4 pages) at actual size (100%).",
      es
        ? "Doble cada hoja por la línea y póngalas todas en una sola bolsa transparente de FedEx, en el orden que dice cada hoja: la etiqueta y la copia del destinatario (CONSIGNEE COPY) al frente, las copias de FedEx detrás."
        : "Fold each page on the line and put all of them in one clear FedEx pouch, in the order printed on each page: the label and the CONSIGNEE COPY facing out, the FedEx copies behind them.",
      es
        ? `Factura comercial: imprima 4 — 3 van en la misma bolsa detrás de las hojas de la etiqueta (1 original + 2 copias) y 1 queda en el archivo.${appInvoice ? " Esta la hizo la app y ya va firmada." : " Firme y feche la original a mano antes de meterla."}`
        : `Commercial invoice: print 4 — 3 go in the same pouch behind the label pages (1 original + 2 copies) and 1 stays on file.${appInvoice ? " This one was made by the app and is already signed." : " Sign and date the original by hand before it goes in."}`,
      es
        ? "Pegue la bolsa en la cara más grande de la caja. Nada de la factura va dentro de la caja sellada."
        : "Stick the pouch on the largest side of the box. No invoice goes inside the sealed box.",
      es
        ? "Los impuestos y aranceles los paga PharmaCenter. Si al destinatario le cobran algo, avise a Logística."
        : "Duties and taxes are paid by PharmaCenter. If the recipient is asked to pay anything, tell Logistics.",
    );
  }
  steps.push(
    ground
      ? es
        ? "Entréguelo en un local de FedEx o al recolector de FedEx Ground. Si se hizo en fin de semana, la fecha de envío es el lunes."
        : "Drop it at a FedEx location or hand it to the FedEx Ground pickup. Made on a weekend? Its ship date is Monday."
      : es
        ? "Entréguelo hoy en un local de FedEx o al recolector de FedEx Express, antes de la hora límite."
        : "Drop it at a FedEx location or hand it to the FedEx Express pickup today, before the cutoff.",
  );
  if (signature) steps.push(es ? "Requiere firma: avise al destinatario que alguien debe recibirlo." : "Signature required: let the recipient know someone has to be there to sign.");
  if (recipientPays) steps.push(es ? "Lo paga el destinatario con su cuenta FedEx." : "Billed to the recipient's FedEx account.");
  steps.push(
    es
      ? "¿No se va a enviar? Anúlelo aquí (Anular) el mismo día — una etiqueta que no se usa ni se anula puede cobrarse."
      : "Not shipping it after all? Void it here the same day — a label that is neither used nor voided can be billed.",
  );

  return (
    <div style={{ marginTop: 10 }}>
      <b>{es ? "Cómo enviarlo" : "How to send it"}</b>
      <ol style={{ margin: "6px 0 0", paddingLeft: 20, lineHeight: 1.5 }}>
        {steps.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ol>
    </div>
  );
}
