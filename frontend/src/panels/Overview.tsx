import { useEffect, useState } from "react";

import { api, type MissingReport, type Profile } from "../api";
import { MagnitudeBarH } from "../charts";
import { Card, Msg, Spinner, TableView, Tile } from "../ui";

export function Overview({ filename }: { filename: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [missing, setMissing] = useState<MissingReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.profile(filename), api.missing(filename)])
      .then(([p, m]) => {
        if (cancelled) return;
        setProfile(p);
        setMissing(m);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [filename]);

  if (loading) return <Spinner label={`Profiling ${filename}…`} />;
  if (error) return <Msg kind="err">{error}</Msg>;
  if (!profile) return null;

  const numeric = profile.columns.filter((c) =>
    /int|float/.test(c.dtype),
  ).length;
  const withMissing = profile.columns.filter((c) => c.n_missing > 0).length;
  const missingRows = missing?.missing ?? [];

  return (
    <div className="grid">
      <div className="kpis">
        <Tile
          label="Rows"
          value={profile.n_rows.toLocaleString()}
          sub={profile.filename}
        />
        <Tile
          label="Columns"
          value={profile.n_columns}
          sub={`${numeric} numeric · ${profile.n_columns - numeric} other`}
        />
        <Tile
          label="Columns with gaps"
          value={withMissing}
          sub={withMissing ? "needs an imputation plan" : "complete dataset"}
        />
        <Tile
          label="Widest gap"
          value={
            missingRows.length ? `${missingRows[0].pct_missing.toFixed(1)}%` : "0%"
          }
          sub={missingRows.length ? missingRows[0].column : "nothing missing"}
        />
      </div>

      <Card
        title="Missing data by column"
        hint={
          missingRows.length
            ? "Share of rows where the value is absent. Only columns with gaps are shown."
            : undefined
        }
      >
        {missingRows.length === 0 ? (
          <Msg kind="ok">{missing?.message ?? "No missing values."}</Msg>
        ) : (
          <>
            <MagnitudeBarH
              data={missingRows.map((r) => ({
                column: r.column,
                percent: r.pct_missing,
              }))}
              nameKey="column"
              valueKey="percent"
              unit="% of rows"
              maxDomain={100}
            />
            <TableView
              headers={["Column", "Missing", "% of rows"]}
              rows={missingRows.map((r) => [
                r.column,
                r.n_missing,
                r.pct_missing.toFixed(2),
              ])}
            />
          </>
        )}
      </Card>

      <Card title="Schema" hint="Dtype, distinct values, and gaps per column.">
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Column</th>
                <th>Dtype</th>
                <th className="num">Distinct</th>
                <th className="num">Missing</th>
              </tr>
            </thead>
            <tbody>
              {profile.columns.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td style={{ color: "var(--text-secondary)" }}>{c.dtype}</td>
                  <td className="num">{c.n_unique.toLocaleString()}</td>
                  <td className="num">
                    {c.n_missing ? c.n_missing.toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Sample rows" hint="First rows as loaded by pandas.">
        <div className="scroll">
          <table>
            <thead>
              <tr>
                {profile.columns.map((c) => (
                  <th key={c.name}>{c.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {profile.sample.map((row, i) => (
                <tr key={i}>
                  {profile.columns.map((c) => (
                    <td key={c.name}>
                      {row[c.name] === null || row[c.name] === undefined
                        ? "—"
                        : String(row[c.name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
