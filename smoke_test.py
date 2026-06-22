"""Quick smoke test: exercises the underlying tool functions directly
(bypassing the MCP transport) to confirm they run end-to-end."""

import mcp_server as s

print("=== list_datasets ===")
print(s.list_datasets())

print("\n=== profile_dataset ===")
print(s.profile_dataset("train.csv", sample_rows=2)[:600], "...")

print("\n=== detect_missing_values ===")
print(s.detect_missing_values("train.csv"))

print("\n=== correlation_analysis (top) ===")
import json
corr = json.loads(s.correlation_analysis("train.csv"))
print(json.dumps(corr["top_correlations"][:5], indent=2))

print("\n=== value_counts: Survived ===")
print(s.value_counts("train.csv", "Survived"))

print("\n=== plot_distribution: Age ===")
print(s.plot_distribution("train.csv", "Age"))

print("\n=== train_model: predict Survived ===")
res = json.loads(
    s.train_model(
        "train.csv",
        target="Survived",
        features=["Pclass", "Sex", "Age", "SibSp", "Parch", "Fare", "Embarked"],
    )
)
print("task:", res["task"], "| accuracy:", res["metrics"]["accuracy"])
print("top features:", [f["feature"] for f in res["top_features"][:5]])
print("saved:", res["saved_model"])

print("\n=== list_models ===")
print(s.list_models())

print("\n=== predict: inline records ===")
pred = json.loads(
    s.predict(
        "train_Survived_classification",
        records=[
            {"Pclass": 1, "Sex": "female", "Age": 38, "SibSp": 1, "Parch": 0, "Fare": 71.3, "Embarked": "C"},
            {"Pclass": 3, "Sex": "male", "Age": 22, "SibSp": 1, "Parch": 0, "Fare": 7.25, "Embarked": "S"},
        ],
    )
)
for row in pred["predictions"]:
    print(row)

print("\n=== predict: whole CSV with id_column, save to CSV ===")
pred2 = json.loads(
    s.predict(
        "train_Survived_classification",
        filename="train.csv",
        id_column="PassengerId",
        save_csv=True,
        top_n=3,
    )
)
print("n_predicted:", pred2["n_predicted"], "| saved_csv:", pred2["saved_csv"])
print("first 3:", pred2["predictions"])

print("\n=== resource: dataset schema ===")
print(s.dataset_schema_resource("train.csv")[:300], "...")

print("\nALL TESTS PASSED")
