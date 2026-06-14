import { redirect } from "next/navigation";

// The pre-DB "review then push" page is gone. Workflows now live in the DB
// and have their own management page at /workflow/[id]. Anyone landing on
// the old URL gets sent to the workflow inbox.
export default function WorkflowReviewRedirect(): never {
  redirect("/workflows");
}
