// Thin wrapper around the monday.com GraphQL API. Server-side only —
// MONDAY_API_TOKEN is a personal access token and must never reach the browser.
//
// Board mapping is centralised here so the route handler stays focused on
// shaping the payload from the workflow URL params.

const MONDAY_GRAPHQL_URL = "https://api.monday.com/v2";
const MONDAY_FILE_URL = "https://api.monday.com/v2/file";

// The board these items land on. See the board structure documented in the
// `Quotes` monday board (created 2026-06-10 by Jairo Osorno, ID 18417125005).
export const QUOTES_BOARD_ID = 18417125005;

// Column IDs on the Quotes board. Update if the board structure changes —
// fetch with `get_board_info` and refresh this map.
export const QUOTES_COLUMNS = {
  date: "date4",
  customer: "text_mm466n79",
  type: "text_mm4675k1",
  qty: "text_mm4828gk",
  submitter: "multiple_person_mm4615kr",
  files: "file_mm46grfp",
} as const;

type MondayUserLookup = { id: string; name: string; email: string } | null;

type MondayResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
  error_code?: string;
  error_message?: string;
};

function token() {
  const t = process.env.MONDAY_API_TOKEN;
  if (!t) {
    throw new Error(
      "MONDAY_API_TOKEN is not set. Add it as a Shared env var in Vercel.",
    );
  }
  return t;
}

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<MondayResponse<T>> {
  const res = await fetch(MONDAY_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: token(),
      "Content-Type": "application/json",
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
    // Server-side only — no caching of mutations.
    cache: "no-store",
  });
  // Read the body as text first so a non-JSON response (HTML error page,
  // rate-limit notice, empty 5xx) surfaces with the actual content instead
  // of crashing on JSON.parse and erasing the diagnostic.
  const raw = await res.text();
  if (!raw) {
    return { errors: [{ message: `HTTP ${res.status} (empty body)` }] } as MondayResponse<T>;
  }
  try {
    return JSON.parse(raw) as MondayResponse<T>;
  } catch {
    console.error(`monday gql non-JSON response HTTP ${res.status}: ${raw.slice(0, 500)}`);
    return { errors: [{ message: `non-JSON HTTP ${res.status}: ${raw.slice(0, 200)}` }] } as MondayResponse<T>;
  }
}

/**
 * Look up a monday user by email. Returns null if no user matches.
 * Used so we can populate the Submitter people column with the signed-in
 * Supabase user's monday person ID.
 */
export async function findUserByEmail(email: string): Promise<MondayUserLookup> {
  const query = `
    query ($emails: [String!]) {
      users(emails: $emails) {
        id
        name
        email
      }
    }
  `;
  const body = await gql<{ users: Array<{ id: string; name: string; email: string }> }>(
    query,
    { emails: [email] },
  );
  if (body.errors?.length) {
    console.error("monday users() query errors:", body.errors);
    return null;
  }
  const u = body.data?.users?.[0];
  return u ?? null;
}

export type CreateItemPayload = {
  itemName: string;
  customerName: string;
  typeLabel: string;
  qtyText?: string;
  submitterMondayId?: string | number | null;
};

/**
 * Create a new item on the Quotes board. Returns the new item ID + URL.
 */
export async function createQuoteItem(payload: CreateItemPayload): Promise<{
  id: string;
  url: string;
}> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const columnValues: Record<string, unknown> = {
    [QUOTES_COLUMNS.date]: { date: today },
    [QUOTES_COLUMNS.customer]: payload.customerName,
    [QUOTES_COLUMNS.type]: payload.typeLabel,
  };

  if (payload.qtyText && payload.qtyText.trim().length > 0) {
    columnValues[QUOTES_COLUMNS.qty] = payload.qtyText.trim();
  }

  if (payload.submitterMondayId) {
    columnValues[QUOTES_COLUMNS.submitter] = {
      personsAndTeams: [
        { id: Number(payload.submitterMondayId), kind: "person" },
      ],
    };
  }

  const query = `
    mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(
        board_id: $boardId,
        item_name: $itemName,
        column_values: $columnValues
      ) {
        id
        name
      }
    }
  `;
  const body = await gql<{ create_item: { id: string; name: string } }>(query, {
    boardId: String(QUOTES_BOARD_ID),
    itemName: payload.itemName,
    columnValues: JSON.stringify(columnValues),
  });

  if (body.errors?.length || !body.data?.create_item) {
    const message = body.errors?.[0]?.message || body.error_message || "Unknown monday API error";
    throw new Error(`monday create_item failed: ${message}`);
  }

  const id = body.data.create_item.id;
  return {
    id,
    url: `https://pharmacenterusa-squad.monday.com/boards/${QUOTES_BOARD_ID}/pulses/${id}`,
  };
}

/**
 * Post an update (comment) on a monday item. Used to add the
 * "Hi Rosy, can we please start the quoting process…" intro.
 * Returns the new update ID, or null on failure (we log and keep going).
 */
export async function postUpdate(itemId: string, body: string): Promise<string | null> {
  const query = `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }
  `;
  const result = await gql<{ create_update: { id: string } }>(query, { itemId, body });
  if (result.errors?.length) {
    console.error("monday create_update errors:", result.errors);
    return null;
  }
  return result.data?.create_update?.id ?? null;
}

/**
 * Upload a file to a file-type column on a monday item.
 * Uses monday's multipart-form-data /v2/file endpoint (separate from the
 * GraphQL /v2 endpoint). The `variables[file]` field name is the magic
 * monday uses to attach the binary to the GraphQL $file variable.
 */
export async function uploadFileToColumn(
  itemId: string,
  columnId: string,
  blob: Blob,
  filename: string,
): Promise<{ id: string } | null> {
  // monday's /v2/file endpoint is finicky:
  //   - The ONLY variable it accepts is $file. item_id and column_id must be
  //     literal values inside the GraphQL string — passing them as $itemId /
  //     $columnId variables causes monday to return an empty 400.
  //   - The file goes in a form field literally named "variables[file]".
  //
  // Pass a Blob + explicit filename rather than a File so the multipart
  // part's filename and Content-Type don't depend on the runtime's File ctor.
  const query = `mutation ($file: File!) {
    add_file_to_column(file: $file, item_id: ${itemId}, column_id: "${columnId}") { id }
  }`;

  const formData = new FormData();
  formData.append("query", query);
  formData.append("variables[file]", blob, filename);

  try {
    const res = await fetch(MONDAY_FILE_URL, {
      method: "POST",
      headers: { Authorization: token() },
      body: formData,
      cache: "no-store",
    });

    // Read the body as text first so a non-JSON response surfaces the
    // monday error message in our logs instead of a generic JSON-parse crash.
    const raw = await res.text();
    if (!raw) {
      console.error(`monday add_file_to_column empty body for ${filename}: HTTP ${res.status}`);
      return null;
    }

    let parsed: MondayResponse<{ add_file_to_column: { id: string } }>;
    try {
      parsed = JSON.parse(raw) as MondayResponse<{ add_file_to_column: { id: string } }>;
    } catch {
      console.error(
        `monday add_file_to_column non-JSON for ${filename}: HTTP ${res.status} body=${raw.slice(0, 500)}`,
      );
      return null;
    }

    if (parsed.errors?.length || !parsed.data?.add_file_to_column) {
      const message = parsed.errors?.[0]?.message || parsed.error_message || `HTTP ${res.status}`;
      console.error(`monday add_file_to_column failed for ${filename}:`, message);
      return null;
    }
    return parsed.data.add_file_to_column;
  } catch (err) {
    console.error(`monday add_file_to_column threw for ${filename}:`, err);
    return null;
  }
}
