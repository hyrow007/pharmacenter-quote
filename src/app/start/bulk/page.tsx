// Wizard step replaced by the single-page /start workflow.
import { redirect } from "next/navigation";

export default function BulkRedirect() {
  redirect("/start");
}
