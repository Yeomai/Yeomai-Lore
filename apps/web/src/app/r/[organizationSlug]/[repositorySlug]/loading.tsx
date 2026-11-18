import { getI18n } from "../../../../i18n/server";

export default async function RepositoryLoading() {
  const { messages } = await getI18n();
  return (
    <div className="page-stack" aria-busy="true" aria-live="polite">
      <section className="panel">
        <p className="muted">{messages.repository.loadingRepository}</p>
        <div className="import-progress-track indeterminate">
          <span />
        </div>
      </section>
    </div>
  );
}
