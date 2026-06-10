// Thin wrapper around the monday.com GraphQL API. Server-side only —
// MONDAY_API_TOKEN is a personal access token and must never reach the browser.

const MONDAY_GRAPHQL_URL = "https://api.monday.com/v2";

export const QUOTES_BOARD_ID = 18417125005;

export const QUOTES_COLUMNS = {
  date: "date4",
  customer: "text_mm466n79",
  type: "text_mm4675k1",
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

