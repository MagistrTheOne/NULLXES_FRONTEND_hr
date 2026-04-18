import { sql } from "@/app/lib/db";
import { revalidatePath } from "next/cache";

export const dynamic = "force-dynamic";

export default async function ActionPage() {
  async function createComment(formData: FormData) {
    "use server";
    const comment = formData.get("comment") as string;
    await sql`INSERT INTO comments (comment) VALUES (${comment})`;
    revalidatePath("/action");
  }

  async function getComments() {
    const rows = await sql`SELECT * FROM comments`;
    return rows as { id: number; comment: string }[];
  }

  return (
    <div className="p-8">
      <h2 className="text-xl font-semibold">Server Action Example</h2>
      <p className="mt-1 text-sm text-slate-600">
        Run <code className="rounded bg-slate-100 px-1">npm run db:push</code> once so the{" "}
        <code className="rounded bg-slate-100 px-1">comments</code> table exists.
      </p>
      <form action={createComment} className="mt-4 flex flex-wrap gap-2">
        <input
          type="text"
          name="comment"
          placeholder="Add a comment"
          className="min-w-[200px] rounded border border-slate-300 px-3 py-2"
          required
        />
        <button type="submit" className="rounded bg-slate-900 px-4 py-2 text-white">
          Submit
        </button>
      </form>
      <h3 className="mt-6 font-medium">Comments:</h3>
      <ul className="mt-2 list-inside list-disc">
        {(await getComments()).map((c) => (
          <li key={c.id}>{c.comment}</li>
        ))}
      </ul>
    </div>
  );
}
