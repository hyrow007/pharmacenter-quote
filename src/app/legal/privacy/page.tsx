import { LegalPage } from "../LegalPage";

export const metadata = { title: "Privacy policy · PharmaCenter Overhead" };

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy policy — PharmaCenter Overhead"
      updated="Last updated November 8, 2026 · Última actualización: 8 de noviembre de 2026"
      en={
        <>
          <p>
            PharmaCenter Overhead is an internal tool operated by PharmaCenter (Davie, Florida) for its own staff. It is
            not offered to the public or to other businesses.
          </p>
          <h2 style={h2}>What it reads</h2>
          <p>
            When an authorized PharmaCenter administrator connects it, the app reads monthly totals for a small set of
            expense accounts (for example electricity, insurance, cleaning) from PharmaCenter&apos;s own QuickBooks Online
            company. It does not read customer, vendor, employee or payment records.
          </p>
          <h2 style={h2}>How it is used</h2>
          <p>
            The totals are averaged and shown to PharmaCenter administrators as a proposed update to the overhead figures
            used in internal cost estimates. Nothing changes until an administrator approves it.
          </p>
          <h2 style={h2}>Where it is kept</h2>
          <p>
            Data is stored in PharmaCenter&apos;s own database, hosted in the United States. The QuickBooks connection
            credentials are encrypted and are never sent to a web browser. Only signed-in PharmaCenter administrators can
            see the figures.
          </p>
          <h2 style={h2}>Sharing</h2>
          <p>The data is not sold, rented or shared with anyone outside PharmaCenter.</p>
          <h2 style={h2}>Disconnecting</h2>
          <p>
            The connection can be removed at any time from the app or from QuickBooks Online (Settings → Apps). After that
            the app reads nothing further; figures already approved remain part of PharmaCenter&apos;s records.
          </p>
          <h2 style={h2}>Contact</h2>
          <p>Questions about this policy can be sent to PharmaCenter through pharmacenterusa.com.</p>
        </>
      }
      es={
        <>
          <p>
            PharmaCenter Overhead es una herramienta interna operada por PharmaCenter (Davie, Florida) para su propio
            personal. No se ofrece al público ni a otras empresas.
          </p>
          <h2 style={h2}>Qué lee</h2>
          <p>
            Cuando un administrador autorizado de PharmaCenter la conecta, la aplicación lee los totales mensuales de un
            pequeño grupo de cuentas de gastos (por ejemplo electricidad, seguros, limpieza) de la compañía de QuickBooks
            Online de PharmaCenter. No lee registros de clientes, proveedores, empleados ni pagos.
          </p>
          <h2 style={h2}>Cómo se usa</h2>
          <p>
            Los totales se promedian y se muestran a los administradores de PharmaCenter como una propuesta para actualizar
            los gastos generales usados en estimaciones de costos internas. Nada cambia hasta que un administrador lo aprueba.
          </p>
          <h2 style={h2}>Dónde se guarda</h2>
          <p>
            Los datos se guardan en la base de datos propia de PharmaCenter, alojada en los Estados Unidos. Las credenciales
            de la conexión con QuickBooks están cifradas y nunca se envían a un navegador. Solo los administradores de
            PharmaCenter con sesión iniciada pueden ver las cifras.
          </p>
          <h2 style={h2}>Compartir</h2>
          <p>Los datos no se venden, alquilan ni comparten con nadie fuera de PharmaCenter.</p>
          <h2 style={h2}>Desconexión</h2>
          <p>
            La conexión se puede quitar en cualquier momento desde la aplicación o desde QuickBooks Online (Configuración →
            Aplicaciones). Después de eso la aplicación no lee nada más; las cifras ya aprobadas siguen siendo parte de los
            registros de PharmaCenter.
          </p>
          <h2 style={h2}>Contacto</h2>
          <p>Las preguntas sobre esta política se pueden enviar a PharmaCenter a través de pharmacenterusa.com.</p>
        </>
      }
    />
  );
}

const h2 = { fontSize: 17, margin: "22px 0 6px" } as const;
