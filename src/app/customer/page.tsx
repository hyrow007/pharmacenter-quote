// The wizard was replaced by the single-page /start workflow.
// Anyone who hits this URL gets bounced to the new home of the form.
import { redirect } from "next/navigation";

export default function CustomerRedirect() {
  redirect("/start");
}
