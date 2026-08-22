import { useCallback, useEffect, useMemo, useState } from "react";

import {
  api,
  type PredictResult,
  type Profile,
  type SavedModel,
  type TrainResult,
} from "../api";
import { MagnitudeBarH } from "../charts";
import { Card, Msg, Spinner, TableView, Tile } from "../ui";

/** Coerce a form string to number when it looks numeric; keep blanks as null. */
function coerce(raw: string): string | number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && /^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(t) ? n : t;
}

export function Model({ filename }: { filename: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [target, setTarget] = useState("");
  const [training, setTraining] = useState(false);
  const [result, setResult] = useState<TrainResult | null>(null);
  const [models, setModels] = useState<SavedModel[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [selectedModel, setSelectedModel] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [prediction, setPrediction] = useState<PredictResult | null>(null);
  const [predicting, setPredicting] = useState(false);

  const refreshModels = useCallback(() => {
    api
      .models()
      .then(setModels)
      .catch(() => setModels([]));
  }, []);

  useEffect(() => {
    setResult(null);
    setError(null);
    api
      .profile(filename)
      .then((p) => {
        setProfile(p);
        setTarget(p.columns[p.columns.length - 1]?.name ?? "");
      })
      .catch((e: Error) => setError(e.message));
    refreshModels();
  }, [filename, refreshModels]);

  const activeModel = useMemo(
    () => models.find((m) => m.model === selectedModel),
    [models, selectedModel],
  );

  // Reset the prediction form when the chosen model changes.
  useEffect(() => {
    setInputs({});
    setPrediction(null);
  }, [selectedModel]);

  async function train() {
    setTraining(true);
    setError(null);
    setResult(null);
    try {
      // Drop the target's own column and obvious identifier columns: a column
      // as unique as the row count carries no signal and inflates the model.
      const features = profile?.columns
        .filter(
          (c) =>
            c.name !== target &&
            !(c.n_unique === profile.n_rows && /int|float|object/.test(c.dtype)),
        )
        .map((c) => c.name);
      const r = await api.train({ filename, target, features });
      setResult(r);
      refreshModels();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTraining(false);
    }
  }

  async function predict() {
    if (!activeModel?.features) return;
    setPredicting(true);
    setError(null);
    try {
      const record: Record<string, unknown> = {};
      for (const f of activeModel.features) record[f] = coerce(inputs[f] ?? "");
      setPrediction(await api.predict(selectedModel, [record]));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPredicting(false);
    }
  }

  const metrics = result?.metrics as Record<string, number> | undefined;

  return (
    <div className="grid">
      {error ? <Msg kind="err">{error}</Msg> : null}

      <Card
        title="Train a model"
        hint="Fits a RandomForest inside a preprocessing pipeline, evaluates it on a held-out split, and saves it."
      >
        <div className="filterbar">
          <div className="field">
            <label htmlFor="target">Predict which column?</label>
            <select
              id="target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {profile?.columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.dtype}, {c.n_unique} distinct)
                </option>
              ))}
            </select>
          </div>
          <button className="btn" onClick={train} disabled={training || !target}>
            {training ? "Training…" : "Train model"}
          </button>
        </div>

        {training ? (
          <Spinner label="Fitting 200 trees — this takes a few seconds…" />
        ) : null}

        {result ? (
          <>
            <div className="kpis" style={{ marginBottom: 14 }}>
              <Tile label="Task" value={result.task} sub={`target: ${result.target}`} />
              {result.task === "classification" ? (
                <Tile
                  label="Accuracy"
                  value={`${((metrics?.accuracy ?? 0) * 100).toFixed(1)}%`}
                  sub="on the held-out split"
                />
              ) : (
                <>
                  <Tile label="R²" value={(metrics?.r2 ?? 0).toFixed(3)} />
                  <Tile label="RMSE" value={(metrics?.rmse ?? 0).toFixed(3)} />
                </>
              )}
              <Tile
                label="Split"
                value={`${result.n_train} / ${result.n_test}`}
                sub="train / test rows"
              />
              <Tile
                label="Features used"
                value={result.features_used.length}
                sub={result.features_used.slice(0, 3).join(", ") + "…"}
              />
            </div>

            <h3 className="h">What drives the prediction</h3>
            <p className="sub">
              Importance after one-hot encoding, so a categorical column appears once
              per level.
            </p>
            <MagnitudeBarH
              data={result.top_features.slice(0, 10).map((f) => ({
                feature: f.feature.replace(/^(num|cat)__/, ""),
                importance: Number(f.importance.toFixed(4)),
              }))}
              nameKey="feature"
              valueKey="importance"
              title={`What drives ${result.target}`}
              exportName={`feature-importance-${result.target}`}
            />
            <TableView
              name={`feature-importance-${result.target}`}
              headers={["Feature", "Importance"]}
              rows={result.top_features.map((f) => [
                f.feature,
                f.importance.toFixed(4),
              ])}
            />
          </>
        ) : null}
      </Card>

      <Card
        title="Score a new record"
        hint="Pick a saved model, describe a case, and get the predicted target back."
      >
        {models.length === 0 ? (
          <Msg>No saved models yet. Train one above.</Msg>
        ) : (
          <>
            <div className="filterbar">
              <div className="field">
                <label htmlFor="model">Model</label>
                <select
                  id="model"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                >
                  <option value="">Select a model…</option>
                  {models.map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.model} → {m.target ?? "?"} ({m.task ?? "?"})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {activeModel?.features ? (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                    gap: 10,
                    marginBottom: 14,
                  }}
                >
                  {activeModel.features.map((f) => (
                    <div className="field" key={f}>
                      <label htmlFor={`in-${f}`}>{f}</label>
                      <input
                        id={`in-${f}`}
                        value={inputs[f] ?? ""}
                        placeholder="blank = unknown"
                        onChange={(e) =>
                          setInputs((prev) => ({ ...prev, [f]: e.target.value }))
                        }
                      />
                    </div>
                  ))}
                </div>
                <button className="btn" onClick={predict} disabled={predicting}>
                  {predicting ? "Scoring…" : "Predict"}
                </button>
              </>
            ) : null}

            {prediction?.predictions?.length ? (
              <div style={{ marginTop: 16 }}>
                <div className="label" style={{ color: "var(--text-muted)" }}>
                  Predicted {prediction.target}
                </div>
                <div className="hero">
                  {String(prediction.predictions[0][prediction.target])}
                </div>
                {prediction.predictions[0].confidence !== undefined ? (
                  <div className="sub">
                    confidence{" "}
                    {(Number(prediction.predictions[0].confidence) * 100).toFixed(1)}%
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
