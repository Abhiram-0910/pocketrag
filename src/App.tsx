import { DropZone } from './components/DropZone'
import { ChunkPreview } from './components/ChunkPreview'
import { EmbeddingProof } from './components/EmbeddingProof'
import { QueryPanel } from './components/QueryPanel'

function App() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold text-gray-900">PocketRAG</h1>
      <p className="mt-1 text-gray-500">Drop a PDF, then ask a question about it.</p>
      <div className="mt-6">
        <DropZone />
        <EmbeddingProof />
        <QueryPanel />
        <ChunkPreview />
      </div>
    </main>
  )
}

export default App
