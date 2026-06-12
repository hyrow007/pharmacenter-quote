// Thin wrapper around the monday.com GraphQL API. Server-side only —
// MONDAY_API_TOKEN is a personal access token and must never reach the browser.

const MONDAY_GRAPHQL_URL = "https://api.monday.com/v2";
const MONDAY_FILE_URL = "https://api.monday.com/v2/file";

export const QUOTES_BOARD_ID = 18417125005;

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
    cache: "no-store",
  });
  const body = (await res.json()) as MondayResponse<T>;
  return body;
}

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

export async function createQuoteItem(payload: CreateItemPayload): Promise<{
  id: string;
  url: string;
}> {
  const today = new Date().toISOString().slice(0, 10);

  const columnValues: Record<string, unknown> = {
    [QUOTES_COLUMNS.date]: { date: today },
    [QUOTES_COLUMNS.customer]: payload.customerName,
    [QUOTES_COLUMNS.type]: payload.typeLabel,
  };

    if (payload.qtyText && payload.qtyText.trim().length > 0) { columnValues[QUOTES_COLUMNS.qty] = payload.qtyText.trim(); }
  
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
 * Uses monday's multipart-form-data /v2/file endpoint.
 */
export async function uploadFileToColumn(
  itemId: string,
  columnId: string,
  file: File,
): Promise<{ id: string } | null> {
  const query = `
    mutation add_file($file: File!, $itemId: ID!, $columnId: String!) {
      add_file_to_column(file: $file, item_id: $itemId, column_id: $columnId) {
        id
      }
    }
  `;
  const formData = new FormData();
  formData.append("query", query);
  formData.append("variables", JSON.stringify({ itemId, columnId }));
  formData.append("variables[file]", file, file.name);

  const res = await fetch(MONDAY_FILE_URL, {
    method: "POST",
    headers: {
      Authorization: token(),
      "API-Version": "2024-10",
    },
    body: formData,
    cache: "no-store",
  });

  const result = (await res.json()) as MondayResponse<{ add_file_to_column: { id: string } }>;
  if (result.errors?.length || !result.data?.add_file_to_column) {
    const message = result.errors?.[0]?.message || result.error_message || `HTTP ${res.status}`;
    console.error(`monday add_file_to_column failed for ${file.name}:`, message);
    return null;
  }
  return result.data.add_file_to_column;
}
