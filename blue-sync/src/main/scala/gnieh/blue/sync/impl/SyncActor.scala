/*
 * This file is part of the \BlueLaTeX project.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package gnieh.blue
package sync
package impl

import scala.util.{Try, Success, Failure}
import org.osgi.service.log.LogService
import akka.actor.Actor

import java.net.URLEncoder
import java.net.URLDecoder
import java.util.{Date, Calendar}

import name.fraser.neil.plaintext.DiffMatchPatch

import common._
import store._


/** This case class represents the current, internal synchronization context
 *  of the actor (an instance of `SyncActor`).
 *
 *  @author Audric Schiltknecht
 */
case class SyncContext(views: Map[(PeerId, Filepath), DocumentView],
                       documents: Map[Filepath, Document],
                       messages: Map[PeerId, List[Message]],
                       lastModificationTime: Date) {

    def updateViews(views: Map[(PeerId, Filepath), DocumentView]) =
		this.copy(views = views)

    def updateDocuments(documents: Map[Filepath, Document]) =
		this.copy(documents = documents)

    def updateMessages(messages: Map[PeerId, List[Message]]) =
		this.copy(messages = messages)

    def updateLastModificationTime() =
        this.copy(lastModificationTime = Calendar.getInstance.getTime())
}

/** This class encapsulates a result from a synchronization action.
 *  It contains the new synchronization context, and a list (potentially empty)
 *  of resulting synchronization commands to return to the other peer.
 *
 *  @author Audric Schiltknecht
 */
case class SyncActionResult(syncContext: SyncContext, commands: List[Command])


/** This actor handles synchronisation of documents.
 *  It is created upon reception of first `Join` system message,
 *  and should be destroyed when all corresponding `Part` messages
 *  have been received.
 *
 *  @author Audric Schiltknecht
 */
class SyncActor(
    config: PaperConfiguration,
    paperId: PaperId,
    store: Store,
    dmp: DiffMatchPatch,
    val logger: LogService)
  extends Actor
  with Logging {

  import FileUtils._
  import net.liftweb.json.JObject

  private val paperDir = config.paperDir(paperId)

  def receive = receiving(SyncContext(Map.empty[(PeerId, Filepath), DocumentView],
                                      Map.empty[Filepath, Document],
                                      Map.empty[PeerId, List[Message]].withDefaultValue(Nil),
                                      Calendar.getInstance().getTime()))

  def stopping: Receive = {
	case _ => sender ! akka.actor.Status.Failure(new SynchroFailureException(s"Synchronization is being stopped for paper $paperId"))
  }

  def receiving(syncContext: SyncContext): Receive = {

    case Join(peerId, _) =>
      logInfo(s"peer $peerId joined paper $paperId")
      context.become(receiving(syncContext.updateMessages(syncContext.messages + (peerId -> Nil))))

    case Part(peerId, _) => {
      logInfo(s"peer $peerId left paper $paperId")
      val newViews = syncContext.views.filter { case (peer, _) => peer != peerId }
      val newMessages = syncContext.messages - peerId
      context.become(receiving(syncContext.updateViews(newViews).updateMessages(newMessages)))
    }

    case SyncSession(peerId, paperId, commands) => {
      var currentSyncContext = syncContext
      Try {
        val commandResponse = commands flatMap {
          case message: Message => {
            currentSyncContext = processMessage(currentSyncContext, peerId, message).syncContext
            Nil
          }
          case SyncCommand(filename, revision, action) => {
            val actionResult = applyAction(currentSyncContext, peerId, filename, revision, action)
            currentSyncContext = actionResult.syncContext
            actionResult.commands
          }
        }
        val messageResult = retrieveMessages(currentSyncContext, peerId, paperId)
        currentSyncContext = messageResult.syncContext
        sender ! SyncSession(peerId, paperId, commandResponse ++ messageResult.commands)
      } recover {
        case e: Exception =>
          logError(s"Error while processing synchronization from peer $peerId", e)
          sender ! akka.actor.Status.Failure(e)
      }
      context.become(receiving(currentSyncContext))
    }

    case PersistPaper(promise) =>
      promise.complete(persistPapers(syncContext))

    case LastModificationDate(promise) =>
      promise.success(syncContext.lastModificationTime)

    case Stop =>
      logInfo(s"Stop command received for paper $paperId")
      // Stop receiving messages first
	  context.become(stopping)
	  // Clean-up and stop
	  persistPapers(syncContext)
	  context.stop(self)

  }

  def persistPapers(syncContext: SyncContext): Try[Unit] =
    Try {
      for {
        doc <- syncContext.documents.values
      } store.save(doc)
    }

  def applyAction(syncContext: SyncContext,
                  peer: PeerId,
                  filename: Filepath,
                  revision: Long,
                  action: SyncAction): SyncActionResult = {
    // We need to modify the synchronization context in this function
    var currentSyncContext = syncContext

    val filepath = (paperDir / filename).getCanonicalPath

    // Load document and associated view
    val document = currentSyncContext.documents.getOrElse(filepath, store.load(filepath))
    val view = currentSyncContext.views.getOrElse((peer, filepath), new DocumentView(document))
    if (!currentSyncContext.documents.contains(filepath))
      currentSyncContext = currentSyncContext.updateDocuments(syncContext.documents + (filepath -> document))
    if (!currentSyncContext.views.contains((peer, filepath)))
      currentSyncContext = currentSyncContext.updateViews(syncContext.views + ((peer, filepath) -> view))

    logDebug(s"Apply SyncAction: peer=$peer, filename=$filepath, revision=$revision, action=$action")
    logDebug(s"Server shadow revision=${view.serverShadowRevision}, backup shadow revision=${view.backupShadowRevision}")

    // Start by checking revision
    if ((revision != view.serverShadowRevision)
        && (revision == view.backupShadowRevision)) {
      // If the version number does not equal the version number of the shadow,
      // but does equal the version number of the backup shadow, then
      // the previous response was lost, which means the backup shadow
      // and its version number should be copied over to the shadow (step 4)
      // and the local stack should be cleared. Continue.
      logDebug("Restore backup shadow")
      view.restoreBackupShadow()
      currentSyncContext = currentSyncContext.updateLastModificationTime
    }

    // If the version number is equal to one of the edits on the local stack,
    // then this is an acknowledgment of receipt of those edits, which
    // means that edit and those with smaller version numbers should be dropped.
    // Continue.
    view.edits = view.edits.filter {
      case SyncCommand(_, editRev, _) => (editRev > revision)
    }

    if (revision != view.serverShadowRevision) {
      // If the version number is not equal the version number of the shadow,
      // then this means there is a memory/programming/transmission
      // bug so the system should be reinitialized using a 'raw' command.
      // Do not accept any Delta commands for this file
      logWarn(s"Error: revision ($revision) != view.serverShadowRevision (${view.serverShadowRevision}) for file $filepath")
      view.deltaOk = false
    } else if (revision == view.serverShadowRevision) {
      // The version number matches the shadow, proceed.
      view.deltaOk == true
    }

    currentSyncContext = action match {
      case x: Delta => processDelta(currentSyncContext, view, x, revision)
      case x: Raw => processRaw(currentSyncContext, view, x, revision)
      case Nullify => nullify(currentSyncContext, view)
    }
    val response = flushStack(view)
    SyncActionResult(currentSyncContext, response map ( SyncCommand(filename, view.serverShadowRevision, _) ))
  }

  def nullify(syncContext: SyncContext, view: DocumentView): SyncContext = {
    // delete it from store
    store.delete(view.document)
        // remove document from memory
    // only keep views on documents that are not the one we nullify
    syncContext.updateViews(syncContext.views.filterNot { case ((_, path), _) => path == view.document.path })
               .updateDocuments(syncContext.documents - view.document.path)
  }

  def processDelta(syncContext: SyncContext, view: DocumentView, delta: Delta, serverRevision: Long): SyncContext = {
    logDebug(s"Process delta command=$delta, for serverRevision=$serverRevision")

    if (!view.deltaOk) {
      logDebug("Invalid delta, abort")
      return syncContext
    }

    var currentSyncContext = syncContext
    if (serverRevision < view.serverShadowRevision) {
      // Ignore delta on mismatched server shadow
      logDebug("Mismatched server shadow, ignore")
    } else if (delta.revision > view.clientShadowRevision) {
      // System should be re-initialised with Raw command
      view.deltaOk = false
      logDebug("Error: wait for Raw command")
    } else if (delta.revision < view.clientShadowRevision) {
      // Already seen it, drop
      logDebug("Delta already processed, drop")
    } else {
      logDebug("Delta and revision ok, process patches")
      currentSyncContext = applyPatches(syncContext, view, delta)
      view.clientShadowRevision += 1
      view.update()
    }
    view.overwrite = delta.overwrite
    currentSyncContext
  }

  def processRaw(syncContext: SyncContext, view: DocumentView, raw: Raw, serverRevision: Long): SyncContext = {
    // Decode HTML-encoded data
    val data = URLDecoder.decode(raw.data, "UTF-8")
    view.setShadow(data, raw.revision, serverRevision, raw.overwrite)
    syncContext.updateLastModificationTime()
  }

  def processMessage(syncContext: SyncContext, peer: PeerId, message: Message): SyncActionResult = {
    logDebug(s"Process message: $message")

    val updatedMessages = for {
      p <- syncContext.messages.keys
      if (p != peer)
    } yield (p, message :: syncContext.messages(p))

    SyncActionResult(syncContext.updateMessages(updatedMessages.toMap + (peer -> syncContext.messages(peer))), Nil)
  }

  def retrieveMessages(syncContext: SyncContext, peer: PeerId, paperId: PaperId): SyncActionResult =
    syncContext.messages.get(peer) match {
        case None => SyncActionResult(syncContext, Nil)
        case Some(m) =>
            // when retrieving the pending messages for a peer, we empty its queue
            val newSyncContext = syncContext.updateMessages(syncContext.messages.updated(peer, Nil))
            SyncActionResult(newSyncContext, m.toList)
    }

  def applyPatches(syncContext: SyncContext, view: DocumentView, delta: Delta): SyncContext = {
    // Compute diffs
    // XXX: not very Scala-ish...
    val diffs = Try(dmp.diff_fromDelta(view.shadow, delta.data.mkString("\t"))) match {
      case Success(s) => s
      case Failure(e) => {
        logWarn(s"Delta failure, expected length ${view.shadow.length}")
        view.deltaOk = false
        null
      }
    }
    if (diffs == null)
      return syncContext

    // Expand diffs into patch
    val patch = dmp.patch_make(view.shadow, diffs)

    // Update client shadow first
    view.shadow = dmp.diff_text2(diffs)
    view.backupShadow = view.shadow
    view.backupShadowRevision = view.serverShadowRevision
    view.changed = true

    logDebug(s"Old document text: ${view.document.text}")

    // Update server document
    val mastertext = if (delta.overwrite) {
      if (patch != null) {
        view.shadow
      } else {
        view.document.text
      }
    } else {
      val Array(text: String, _) = dmp.patch_apply(patch, view.document.text)
      text
    }
    logDebug(s"New document text: $mastertext")
    view.document.text = mastertext

    if (!patch.isEmpty) {
      logDebug("Patch is not empty -> update modification time")
      syncContext.updateLastModificationTime
    } else {
      syncContext
    }
  }

  def flushStack(view: DocumentView): List[SyncAction] = {
    logDebug("Flush stack")

    val doc = view.document
    val mastertext = doc.text
    val filename = doc.filename

    if (view.deltaOk) {
      logDebug(s"Deltas OK, compute and apply diff on mastertext=$mastertext")
      // compute the diffs with the current master text
      val diffs = dmp.diff_main(view.shadow, mastertext)
      dmp.diff_cleanupEfficiency(diffs)
      // apply the diffs to the text
      val text = dmp.diff_toDelta(diffs)

      // parse back the computed delta texts
      val edits = EditCommandParsers.parseEdits(text)

      logDebug(s"Computed deltas: $edits")

      if (view.overwrite) {
        // Client sending 'D' means number, no error.
        // Client sending 'R' means number, client error.
        // Both cases involve numbers, so send back an overwrite delta.
        view.edits.append(SyncCommand(filename,
                                      view.serverShadowRevision,
                                      Delta(view.serverShadowRevision,
                                            edits,
                                            true)))
      } else {
        // Client sending 'D' means number, no error.
        // Client sending 'R' means number, client error.
        // Both cases involve numbers, so send back a merge delta.
        view.edits.append(SyncCommand(filename,
                                      view.serverShadowRevision,
                                      Delta(view.serverShadowRevision,
                                            edits,
                                            false)))
      }
      view.serverShadowRevision += 1
    } else {
      // Error server could not parse client's delta.
      logDebug("Invalid delta(s)")
      // Send a raw dump of the text.
      view.clientShadowRevision += 1

      if (mastertext.isEmpty) {
        view.edits.append(SyncCommand(filename,
                                      view.serverShadowRevision,
                                      Raw(view.serverShadowRevision,
                                          "",
                                          false)))
      } else {
        // Force overwrite client
        val text = encodeUriCompatibility(mastertext)
        view.edits.append(SyncCommand(filename,
                                      view.serverShadowRevision,
                                      Raw(view.serverShadowRevision,
                                          text,
                                          true)))
      }
    }

    view.shadow = mastertext
    view.changed = true

    view.edits.toList.map {
      case SyncCommand(_, _, command)  => command
    }
  }

  /**
   * Unescape selected chars for compatibility with JavaScript's encodeURI.
   * Taken from "Diff Match Patch" java's implementation by Neil Fraser.
   * @param str The string to escape.
   * @return The escaped string.
   */
  private def encodeUriCompatibility(str: String): String = {
    return URLEncoder.encode(str, "UTF-8")
        .replace('+', ' ').replace("%21", "!").replace("%7E", "~")
        .replace("%27", "'").replace("%28", "(").replace("%29", ")")
        .replace("%3B", ";").replace("%2F", "/").replace("%3F", "?")
        .replace("%3A", ":").replace("%40", "@").replace("%26", "&")
        .replace("%3D", "=").replace("%2B", "+").replace("%24", "$")
        .replace("%2C", ",").replace("%23", "#")
  }

}