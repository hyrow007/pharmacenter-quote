import { LegalPage } from "../LegalPage";

export const metadata = { title: "Terms of use · PharmaCenter Overhead" };

export default function TermsPage() {
  return (
    <LegalPage
      title="End-user terms — PharmaCenter Overhead"
      updated="Last updated November 8, 2026 · Última actualización: 8 de noviembre de 2026"
      en={
        <>
          <p>
            PharmaCenter Overhead is software built and operated by PharmaCenter (Davie, Florida) for internal use by its
            own authorized staff. By using it you agree to these terms.
          </p>
          <h2 style={h2}>Who may use it</h2>
          <p>
            Only PharmaCenter employees with a company account and administrator access. No license is granted to anyone
            else, and access may be withdrawn at any time.
          </p>
          <h2 style={h2}>Your data</h2>
          <p>
            Figures read from QuickBooks Online remain PharmaCenter&apos;s data. The app reads only what is described in the
            privacy policy and writes nothing back to QuickBooks.
          </p>
          <h2 style={h2}>No warranty</h2>
          <p>
            The app is provided as-is for internal estimating. Its figures are proposals for a person to review and are not
            accounting, tax or financial advice.
          </p>
          <h2 style={h2}>Changes</h2>
          <p>PharmaCenter may update these terms; the date above shows the latest version.</p>
          <p>
            See also the <a href="/legal/privacy">privacy policy</a>.
          </p>
        </>
      }
      es={
        <>
          <p>
            PharmaCenter Overhead es un software creado y operado por PharmaCenter (Davie, Florida) para uso interno de su
            propio personal autorizado. Al usarlo, usted acepta estos términos.
          </p>
          <h2 style={h2}>Quién puede usarlo</h2>
          <p>
            Solo empleados de PharmaCenter con una cuenta de la empresa y acceso de administrador. No se otorga licencia a
            nadie más, y el acceso puede retirarse en cualquier momento.
          </p>
          <h2 style={h2}>Sus datos</h2>
          <p>
            Las cifras leídas de QuickBooks Online siguen siendo datos de PharmaCenter. La aplicación lee solo lo descrito
            en la política de privacidad y no escribe nada en QuickBooks.
          </p>
          <h2 style={h2}>Sin garantía</h2>
          <p>
            La aplicación se ofrece tal cual para estimaciones internas. Sus cifras son propuestas para que una persona las
            revise y no constituyen asesoría contable, fiscal ni financiera.
          </p>
          <h2 style={h2}>Cambios</h2>
          <p>PharmaCenter puede actualizar estos términos; la fecha de arriba indica la versión vigente.</p>
          <p>
            Vea también la <a href="/legal/privacy">política de privacidad</a>.
          </p>
        </>
      }
    />
  );
}

const h2 = { fontSize: 17, margin: "22px 0 6px" } as const;
